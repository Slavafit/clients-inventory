require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const fs = require('fs');

const User = require('./models/User');
const Category = require('./models/Category');
const Product = require('./models/Product');
const Order = require('./models/Order');

// --- MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message)); // Добавьте .message
  // Или даже .catch(err => console.error('MongoDB error:', err)); для полного объекта

// --- Google Sheets ---
let sheetsClient = null;
if (process.env.USE_GOOGLE_SHEETS === 'true' && fs.existsSync(process.env.GOOGLE_SHEETS_KEYFILE)) {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SHEETS_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets connected');

  // Создаём заголовки, если лист пуст
  (async () => {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    try {
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:D1',
      });
      if (!res.data.values || res.data.values.length === 0) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: 'Sheet1!A1:D1',
          valueInputOption: 'RAW',
          requestBody: { values: [['Дата', 'Телефон', 'Опись (товары)', 'Сумма']] }
        });
      }
    } catch (err) {
      console.error('Sheets init error:', err.message);
    }
  })();
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_ID = parseInt(process.env.ADMIN_ID || '0', 10);

// --- Главное меню ---
async function showMainMenu(ctx, user) {
  const mainMenuCommands = ['📦 Создать опись', '🧾 Мои отправления', '⚙️ Админ-панель'];
  const menu = [
    ['📦 Создать опись', '🧾 Мои отправления'],
  ];
  if (ctx.from.id === ADMIN_ID) menu.push(['⚙️ Админ-панель']);
  return ctx.reply('📋 Главное меню:', Markup.keyboard(menu).resize());
}

// --- Просмотр и редактирование описи ---
async function showOrderPreview(ctx, user) {
  const items = user.currentOrder.map((i, idx) => `${idx + 1}. ${i.product} — ${i.quantity}шт = ${i.total}₽`).join('\n');
  const totalSum = user.currentOrder.reduce((s, i) => s + i.total, 0);

  const buttons = user.currentOrder.map((i, idx) => [
    { text: `🗑 Удалить ${i.product}`, callback_data: `del_${idx}` }
  ]);
  buttons.push([
    { text: '➕ Добавить товар', callback_data: 'add_more' },
    { text: '✅ Отправить опись', callback_data: 'send_order' }
  ]);
  buttons.push([{ text: '❌ Отменить', callback_data: 'cancel_order' }]);

  await ctx.reply(`📦 Текущая опись:\n\n${items}\n\n💰 Итого: ${totalSum.toFixed(2)}₽`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

// --- Приветствие и регистрация ---
bot.start(async (ctx) => {
  let user = await User.findOne({ telegramId: ctx.from.id });

  if (!user) {
    user = await User.create({ telegramId: ctx.from.id });
  }

  // Если телефон уже есть — предлагаем меню
  if (user.phone) {
    await ctx.reply(
      `С возвращением, ${ctx.from.first_name || 'друг'}!\nВаш текущий номер: ${user.phone}`,
      Markup.keyboard([
        ['📦 Создать опись', '🧾 Мои отправления'],
        ['📞 Изменить номер']
      ]).resize()
    );
    return;
  }

  // Если телефона нет — просим его
  await ctx.reply(
    '👋 Привет! Чтобы начать, отправьте или поделитесь номером телефона.\n\nВы можете:\n📱 Нажать кнопку ниже\nили\n✏️ Ввести номер вручную (в формате +34666777888)',
    Markup.keyboard([[Markup.button.contactRequest('📤 Отправить мой номер')]])
      .oneTime()
      .resize()
  );
});

// --- Приём контакта ---
bot.on('contact', async (ctx) => {
  const phone = ctx.message.contact.phone_number;
  const user = await User.findOneAndUpdate(
    { telegramId: ctx.from.id },
    { phone },
    { new: true, upsert: true }
  );

  await ctx.reply(`✅ Номер сохранён: ${phone}`);
  return showMainMenu(ctx, user);
});

// --- Приём текста (возможен ручной ввод номера) ---
// Замените/вставьте вместо старого обработчика текста
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  // Загружаем пользователя
  let user = await User.findOne({ telegramId: ctx.from.id });

  // Если пользователя нет (на всякий случай) — создаём
  if (!user) {
    user = await User.create({ telegramId: ctx.from.id, currentStep: 'idle', currentOrder: [] });
  }
  const mainMenuCommands = ['📦 Создать опись', '🧾 Мои отправления', '⚙️ Админ-панель', '📞 Изменить номер'];
  if (mainMenuCommands.includes(text)) {
      // Если текст совпадает с одной из команд меню, мы просто выходим (return).
     // Правильный обработчик (bot.hears) сработает сам по себе.
      return; 
    }
  // --- Обработка смены/ввода номера ---
  // Команда для явного изменения основного телефона
  if (text === '📞 Изменить номер') {
    user.currentStep = 'awaiting_new_phone'; // пометка, что ждём ввод нового номера
    await user.save();
    await ctx.reply('Введите новый номер телефона вручную (например: +34666777888), или нажмите кнопку, чтобы поделиться контактом:',
      Markup.keyboard([[Markup.button.contactRequest('📤 Поделиться моим контактом')]]).oneTime().resize());
    return;
  }

  // Если ожидаем новый основной телефон — принимаем ручной ввод
  if (user.currentStep === 'awaiting_new_phone') {
    const phoneCandidate = text.replace(/\s+/g, '');
    if (/^\+?\d{7,15}$/.test(phoneCandidate)) {
      user.phone = phoneCandidate;
      user.currentStep = 'idle';
      await user.save();
      await ctx.reply(`✅ Главный номер обновлён: ${phoneCandidate}`, Markup.removeKeyboard());
      return showMainMenu(ctx, user);
    } else {
      return ctx.reply('Неверный формат номера. Введите, пожалуйста, номер в формате +71234567890');
    }
  }

  // --- Если пользователь ещё не зарегистрировал (нет основного номера) ---
  if (!user.phone) {
    // Попытка ручного ввода номера при регистрации
    const phoneCandidate = text.replace(/\s+/g, '');
    if (/^\+?\d{7,15}$/.test(phoneCandidate)) {
      user.phone = phoneCandidate;
      user.currentStep = 'idle';
      await user.save();
      await ctx.reply(`✅ Номер сохранён: ${phoneCandidate}`, Markup.removeKeyboard());
      return showMainMenu(ctx, user);
    }

    // Любой другой текст до регистрации — просим номер
    return ctx.reply(
      '📱 Пожалуйста, отправьте или поделитесь своим номером телефона, чтобы продолжить.',
      Markup.keyboard([[Markup.button.contactRequest('📤 Отправить номер')]]).oneTime().resize()
    );
  }

  // --- Теперь пользователь точно зарегистрирован (есть основной номер) ---
  // Если пользователь в процессе создания описи — обрабатываем по currentStep
  switch (user.currentStep) {
    case 'awaiting_custom_product':
      // Ввод названия товара вручную
      user.currentOrder = user.currentOrder || [];
      user.currentOrder.push({ product: text }); // добавляем позицию с именем
      user.currentStep = 'awaiting_quantity';
      await user.save();
      await ctx.reply('Введите количество (целое число):');
      return;

    case 'awaiting_quantity':
      {
        const qty = parseInt(text.replace(/[^0-9]/g, ''), 10);
        if (!qty || qty <= 0) {
          return ctx.reply('Введите корректное целое количество (>0).');
        }
        user.currentOrder[user.currentOrder.length - 1].quantity = qty;
        user.currentStep = 'awaiting_total'; // мы просим общую сумму за позицию
        await user.save();
        return ctx.reply('💰 Введите общую сумму за эту позицию (числом, например: 199.99):');
      }

    case 'awaiting_total':
      {
        const total = parseFloat(text.replace(',', '.'));
        if (isNaN(total) || total < 0) {
          return ctx.reply('Введите корректную сумму (число).');
        }
        user.currentOrder[user.currentOrder.length - 1].total = total;
        user.currentStep = 'confirm_order';
        await user.save();
        // Показываем превью описи (используем существующую функцию showOrderPreview)
        return showOrderPreview(ctx, user);
      }

    case 'awaiting_phone_for_one_order':
      {
        // Это режим, если вы реализировали временный номер для текущей описи
        const phoneCandidate = text.replace(/\s+/g, '');
        if (/^\+?\d{7,15}$/.test(phoneCandidate)) {
          user.tempOrderPhone = phoneCandidate; // временный телефон для текущей описи
          user.currentStep = 'idle';
          await user.save();
          await ctx.reply(`Использовать номер ${phoneCandidate} для этой описи.`);
          return showMainMenu(ctx, user);
        } else {
          return ctx.reply('Неверный формат номера. Введите номер вида +71234567890');
        }
      }

    default:
      // Если ничего особого — реагируем на основные пункты меню текстом (если требуется)
      // Например: пользователь может ввести '📦 Создать опись' или '🧾 Мои отправления' — эти хендлеры уже обрабатываются отдельно через bot.hears
      return ctx.reply('Невозможно обработать сообщение. Используйте главное меню или /start для начала.', Markup.keyboard([['📦 Создать опись', '🧾 Мои отправления'], ['📞 Изменить номер']]).resize());
  }
});





// --- Создание описи ---
bot.hears('📦 Создать опись', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder = [];
  user.currentStep = 'idle';
  await user.save();

  const categories = await Category.find();
  const buttons = categories.map(c => [{ text: `${c.emoji} ${c.name}`, callback_data: `cat_${c._id}` }]);
  await ctx.reply('Выберите категорию товара:', { reply_markup: { inline_keyboard: buttons } });
});


// --- Выбор категории ---
bot.action(/cat_.+/, async (ctx) => {
  const categoryId = ctx.match[0].replace('cat_', '');
  const products = await Product.find({ categoryId });
  const buttons = products.map(p => [{ text: p.name, callback_data: `prod_${p._id}` }]);
  await ctx.reply('Выберите товар:', { reply_markup: { inline_keyboard: buttons } });
});

// --- Выбор товара ---
bot.action(/prod_.+/, async (ctx) => {
  const productId = ctx.match[0].replace('prod_', '');
  const product = await Product.findById(productId);
  const user = await User.findOne({ telegramId: ctx.from.id });

  if (product.name.includes('Ввести свой')) {
    user.currentStep = 'awaiting_custom_product';
    await user.save();
    await ctx.reply('Введите название своего товара:');
  } else {
    user.currentOrder.push({ product: product.name });
    user.currentStep = 'awaiting_quantity';
    await user.save();
    await ctx.reply(`Введите количество для "${product.name}":`);
  }
});



// --- Удаление позиции ---
bot.action(/del_\d+/, async (ctx) => {
  const index = parseInt(ctx.match[0].replace('del_', ''));
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder.splice(index, 1);
  await user.save();
  await ctx.answerCbQuery('Удалено');
  await showOrderPreview(ctx, user);
});

// --- Добавить товар ---
bot.action('add_more', async (ctx) => {
  await ctx.answerCbQuery();
  const categories = await Category.find();
  const buttons = categories.map(c => [{ text: `${c.emoji} ${c.name}`, callback_data: `cat_${c._id}` }]);
  await ctx.reply('Выберите категорию:', { reply_markup: { inline_keyboard: buttons } });
});

// --- Отмена описи ---
bot.action('cancel_order', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder = [];
  user.currentStep = 'idle';
  await user.save();
  await ctx.reply('❌ Опись отменена.');
  await showMainMenu(ctx, user);
});

// --- Отправка описи ---
bot.action('send_order', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user.currentOrder.length) return ctx.reply('Опись пуста.');

  const totalSum = user.currentOrder.reduce((s, i) => s + i.total, 0);
  const order = await Order.create({
    userId: user._id,
    items: user.currentOrder,
    totalSum,
    timestamp: new Date()
  });

  // Сохраняем в Google Sheets
  if (sheetsClient) {
    const values = [
      [new Date().toLocaleString(), user.phone, JSON.stringify(order.items), totalSum]
    ];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
  }

  await ctx.reply('✅ Опись отправлена!');
  user.currentOrder = [];
  user.currentStep = 'idle';
  await user.save();

    // Уведомляем админа
  if (ADMIN_ID) {
    await bot.telegram.sendMessage(ADMIN_ID, `📦 Новая опись от ${user.phone}\nИтого: ${totalSum}₽`);
  }

  await showMainMenu(ctx, user);
});

// --- Мои отправления ---
bot.hears('🧾 Мои отправления', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) return ctx.reply('Нажмите /start для регистрации.');

  // Ищем все завершенные заказы пользователя
  const orders = await Order.find({ userId: user._id }).sort({ timestamp: -1 });

  if (!orders || orders.length === 0) {
      return ctx.reply('У вас пока нет отправленных описей.');
  }

  let message = '📋 Ваши последние отправления:\n\n';

  orders.slice(0, 10).forEach((order, index) => { // Показываем до 10 последних
      const total = order.totalSum.toFixed(2);
      const date = order.timestamp.toLocaleDateString('ru-RU');
      
      // Краткое описание товаров
      const itemsSummary = order.items.map(i => `${i.product} (${i.quantity}шт)`).join(', ');
      
      message += `**№${index + 1} (${date})**\n`;
      message += `Итого: ${total}₽\n`;
      message += `Товары: _${itemsSummary}_\n\n`;
  });

  await ctx.reply(message, { parse_mode: 'Markdown' });
});

// --- Админ-панель ---
bot.hears('⚙️ Админ-панель', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  const orders = await Order.find().populate('userId');
  if (!orders.length) return ctx.reply('Нет описи.');

  let text = '📋 Все описи:\n\n';
  orders.forEach((o, i) => {
    text += `${i + 1}. ${o.userId.phone} — ${o.totalSum}₽\n`;
  });

  await ctx.reply(text, Markup.inlineKeyboard([
    [{ text: '❌ Удалить все', callback_data: 'admin_clear' }]
  ]));
});

// --- Удаление всех описи админом ---
bot.action('admin_clear', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return;
  await Order.deleteMany({});
  await ctx.answerCbQuery('Все описи удалены');
  await ctx.reply('✅ Всё очищено.');
});

bot.launch();
console.log('🚀 Bot started');
