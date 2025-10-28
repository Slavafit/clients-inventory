require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const fs = require('fs');

const Category = require('./models/Category');
const Product = require('./models/Product');
const User = require('./models/User');
const Order = require('./models/Order');
const { checkAuth, requestPhone } = require('./middlewares/checkAuth');
const { registerAuthHandlers } = require('./handlers/auth');

// --- Подключение к MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message));

// --- Google Sheets API ---
let sheetsClient = null;
if (process.env.USE_GOOGLE_SHEETS === 'true' && fs.existsSync(process.env.GOOGLE_SHEETS_KEYFILE)) {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SHEETS_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets connected');

  // Проверим наличие заголовков и создадим, если их нет
  (async () => {
    try {
      const sheetId = process.env.GOOGLE_SHEET_ID;
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:D1',
      });
      if (!res.data.values || res.data.values.length === 0) {
        console.log('🆕 Создаю заголовки таблицы...');
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: 'Sheet1!A1:D1',
          valueInputOption: 'RAW',
          requestBody: {
            values: [['Дата', 'Телефон', 'Опись (товары)', 'Сумма']]
          }
        });
        console.log('✅ Заголовки добавлены');
      }
    } catch (err) {
      console.error('⚠️ Не удалось проверить/создать заголовки:', err.message);
    }
  })();
} else {
  console.log('⚠️ Google Sheets disabled or missing keyfile');
}

// --- Инициализация бота ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- Приветствие и регистрация ---
bot.start(async (ctx) => {
  let user = await User.findOne({ telegramId: ctx.from.id });

// 🆕 ВОЗВРАЩАЕМ ПРОВЕРКУ ТЕЛЕФОНА!
  if (!user.phone) {
    console.log(`[START DEBUG] Пользователь начал, но нет телефона. Запрашиваю.`);
    await ctx.reply('Привет! 👋');
    return requestPhone(ctx); // 🟢 Вызываем функцию из Middleware
  }
    
  // 2. Если пользователь и телефон есть, показываем меню.
  console.log(`[START DEBUG] Пользователь авторизован. Показываю меню.`);
  await ctx.reply(`С возвращением, ${ctx.from.first_name}!`);
  return showMainMenu(ctx);
});


bot.on('contact', async (ctx) => {
  const phone = ctx.message.contact.phone_number;
  await User.findOneAndUpdate({ telegramId: ctx.from.id }, { phone });
  console.log(`[CONTACT DEBUG] 4. Телефон ${phone} успешно СОХРАНЁН.`);
  await ctx.reply(`Ваш номер сохранён: ${phone}`, Markup.removeKeyboard());
  return showMainMenu(ctx);
});

// 🟢 РЕГИСТРАЦИЯ ВСЕЙ ЛОГИКИ АВТОРИЗАЦИИ
registerAuthHandlers(bot, User, showMainMenu);

// --- Middleware для проверки авторизации ---
// Передаем модель User в функцию middleware.
bot.use(checkAuth(User));

// --- Главное меню ---
async function showMainMenu(ctx) {
  return ctx.reply('📋 Главное меню. Выберите действие:', Markup.keyboard([
    ['📦 Создать опись', '🧾 Мои отправления'],
    ['🔄 Изменить номер']
  ]).resize());
}

// --- Старт создания описи ---
async function startNewOrder(ctx) {
  const categories = await Category.find();
  const buttons = categories.map(c => [{ text: `${c.emoji} ${c.name}`, callback_data: `cat_${c._id}` }]);
  await ctx.reply('Выберите категорию товара:', { reply_markup: { inline_keyboard: buttons } });
}

// --- Обработчик кнопки "Изменить номер" ---
bot.hears('🔄 Изменить номер', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    // Сбрасываем текущий номер телефона в базе
    user.phone = null; 
    await user.save();
    
    // Запрашиваем новый номер. Middleware checkAuth автоматически 
    // запросит его при следующем действии, но лучше запросить явно.
    await ctx.reply('🗑 Текущий номер удалён. Для продолжения работы введите новый номер.');
    return requestPhone(ctx);
});

// --- Переход к текстовому вводу номера ---
bot.hears('✍️ Ввести другой номер', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    user.currentStep = 'awaiting_new_phone'; // 🆕 НОВЫЙ ШАГ ДИАЛОГА
    await user.save();
    
    return ctx.reply('✍️ Введите номер телефона в международном формате (например, +79123456789):', Markup.removeKeyboard());
});
// --- Обработчик кнопки "Создать опись" ---
bot.hears('📦 Создать опись', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder = [];
  user.currentStep = 'idle';
  await user.save();
  await startNewOrder(ctx);
});


// --- Просмотр отправлений пользователя ---
bot.hears('🧾 Мои отправления', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  
  // 1. Получаем текущий привязанный номер телефона
  const currentPhone = user.phone; 

  // 2. Находим ВСЕХ пользователей, которые используют этот номер
  const usersWithSamePhone = await User.find({ phone: currentPhone }).select('_id');
  const userIds = usersWithSamePhone.map(u => u._id);

  // 3. Ищем заказы, созданные ЛЮБЫМ из этих пользователей
  const orders = await Order.find({ userId: { $in: userIds } }).sort({ timestamp: -1 });
  
  if (!orders.length) return ctx.reply(`📭 У вас пока нет отправлений, связанных с номером ${currentPhone}.`);

  let text = `📦 Ваши отправления (по номеру ${currentPhone}):\n\n`;
  orders.forEach((o, i) => {
     text += `#${i + 1} от ${o.timestamp.toLocaleString()} — ${o.totalSum.toFixed(2)}₽\n`;
  });
    await ctx.reply(text);
});

// --- Обработка выбора категории ---
bot.action(/cat_.+/, async (ctx) => {
  const categoryId = ctx.match[0].replace('cat_', '');
  const category = await Category.findById(categoryId);
  const products = await Product.find({ categoryId });

  const buttons = products.map(p => [{ text: p.name, callback_data: `prod_${p._id}` }]);
  await ctx.reply(`Категория *${category.emoji} ${category.name}*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
});

// --- Обработка выбора товара ---
bot.action(/prod_.+/, async (ctx) => {
  const productId = ctx.match[0].replace('prod_', '');
  const product = await Product.findById(productId);
  const user = await User.findOne({ telegramId: ctx.from.id });

  if (product.name.includes('Ввести свой')) {
    user.currentStep = 'awaiting_custom_product';
    await user.save();
    await ctx.reply('Введите название своего товара:');
  } else {
    user.currentOrder.push({ product: product.name, quantity: 0, total: 0 }); // <--- ИНИЦИАЛИЗАЦИЯ    
    user.currentStep = 'awaiting_quantity';
    await user.save();
    await ctx.reply(`Введите количество для "${product.name}" (в штуках):`);
  }
});

// --- Текстовые ответы пользователя ---
bot.on('text', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  const text = ctx.message.text.trim();

  switch (user.currentStep) {
    case 'awaiting_custom_product':
      user.currentOrder.push({ product: text, quantity: 0, total: 0 });
      user.currentStep = 'awaiting_quantity';
      await user.save();
      return ctx.reply('Введите количество:');

    case 'awaiting_quantity':
      const qty = parseInt(text);
      if (!qty || qty <= 0) return ctx.reply('Введите корректное количество.');
      user.currentOrder[user.currentOrder.length - 1].quantity = qty;
      user.currentStep = 'awaiting_total'; // <-- ИЗМЕНЕНО: awaiting_price -> awaiting_total
      await user.save();
      return ctx.reply('💰 Введите *общую сумму* за эту позицию (например, 19.99):', { parse_mode: 'Markdown' }); // <-- ИЗМЕНЕНО: Текст запроса

      case 'awaiting_total':
      const total = parseFloat(text.replace(',', '.'));
      if (isNaN(total) || total < 0) return ctx.reply('Введите корректную сумму.');
        // Рассчитываем и сохраняем total для позиции
        user.currentOrder[user.currentOrder.length - 1].total = total;
        user.currentStep = 'confirm_order';
        await user.save();
      return showOrderPreview(ctx, user);

      case 'awaiting_new_phone':
        const text = ctx.message.text.trim();
        // Регулярное выражение для очистки строки от всего, кроме цифр
        const cleanedText = text.replace(/[^0-9]/g, ''); 
      
      // Проверка: Должно быть не менее 9 цифр (для большинства стран)
      if (cleanedText.length < 9) {
         return ctx.reply('Пожалуйста, введите корректный номер телефона (не менее 9 цифр).');
      }

     // Форматируем номер, добавляя '+' в начало, если его нет (для удобства поиска)
        let formattedPhone = text.trim();
        if (!formattedPhone.startsWith('+')) {
            formattedPhone = '+' + formattedPhone;
        }

      // Сохраняем отформатированный номер
      user.phone = formattedPhone;
      user.currentStep = 'idle';
      await user.save();
      
      await ctx.reply(`Ваш новый номер сохранён: ${formattedPhone}`);
      return showMainMenu(ctx);

        default:
        // Если пользователь вводит произвольный текст, когда бот не ждет ответа.
      return ctx.reply('🤔 Я не понимаю эту команду. Воспользуйтесь меню или выберите действие.');
  }
});

// --- Функция предпросмотра и редактирования описи ---
async function showOrderPreview(ctx, user) {
    const items = user.currentOrder.map((i, idx) => {
        // 1. Проверяем, существует ли i.total. Если нет, используем 0.
        const itemTotal = i.total && !isNaN(i.total) ? i.total : 0; 
        
        // 2. Отображаем элемент
        return `${idx + 1}. ${i.product} — ${i.quantity}шт, всего *${itemTotal.toFixed(2)}€*`;
    }).join('\n');
    // Общая сумма по описи - просто суммируем total из каждой позиции
    const total = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);

  const buttons = user.currentOrder.map((i, idx) => [
    { text: `🗑 Удалить ${i.product}`, callback_data: `del_${idx}` }
  ]);
  buttons.push([
    { text: '➕ Добавить товар', callback_data: 'add_more' },
    { text: '✅ Отправить опись', callback_data: 'send_order' }
  ]);
  buttons.push([{ text: '❌ Отменить', callback_data: 'cancel_order' }]);

  await ctx.reply(`📦 Текущая опись:\n\n${items}\n\nИтого: ${total.toFixed(2)}€`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

// --- Удаление товара из описи ---
bot.action(/del_\d+/, async (ctx) => {
  const index = parseInt(ctx.match[0].replace('del_', ''));
  const user = await User.findOne({ telegramId: ctx.from.id });

  if (user.currentOrder[index]) {
    user.currentOrder.splice(index, 1);
    await user.save();
    await ctx.answerCbQuery('🗑 Товар удалён');
    await showOrderPreview(ctx, user);
  } else {
    await ctx.answerCbQuery('⚠️ Элемент не найден');
  }
});

// --- Добавить ещё товар ---
bot.action('add_more', async (ctx) => {
  await ctx.answerCbQuery();
  await startNewOrder(ctx);
});

// --- Отмена ---
bot.action('cancel_order', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder = [];
  user.currentStep = 'idle';
  await user.save();
  await ctx.reply('❌ Опись отменена.');
  await showMainMenu(ctx);
});

// --- Подтверждение и отправка ---
bot.action('send_order', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user || !user.currentOrder.length) return ctx.reply('Ошибка: нет товаров.');

  const total = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
  const order = await Order.create({
    userId: user._id,
    items: user.currentOrder,
    totalSum: total
  });

  if (sheetsClient) {
    const values = [
      [new Date().toLocaleString(), user.phone, JSON.stringify(order.items), total]
    ];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:D',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
  }

  user.currentOrder = [];
  user.currentStep = 'idle';
  await user.save();

  await ctx.reply('✅ Опись успешно отправлена!');
  await showMainMenu(ctx);
});

// --- Глобальный обработчик ошибок ---
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте ещё раз.');
});

// --- Запуск бота ---
bot.launch();
console.log('🚀 Telegram bot started...');
