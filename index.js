require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const fs = require('fs');

const Category = require('./models/Category');
const Product = require('./models/Product');
const User = require('./models/User');
const Order = require('./models/Order');
// сервисы
const adminService = require('./services/adminService'); // Убедитесь, что этот файл существует!
const registerAdminHandlers = require('./handlers/admin');
const { checkAuth } = require('./middlewares/checkAuth');
const { registerAuthHandlers } = require('./middlewares/auth');
const { callbackDebug } = require('./middlewares/callbackDebug');
const { 
        showCategorySelection, 
        showAdminCategorySelection 
    } = require('./handlers/category');
//const { INSTRUCTIONS_TEXT } = require('./data/texts');

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

  (async () => {
    try {
      const sheetId = process.env.GOOGLE_SHEET_ID;
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:D1',
      });
      if (!res.data.values || res.data.values.length === 0) {
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


// --- Middleware ---
bot.use(checkAuth(User));
bot.use(callbackDebug());

// 🟢 РЕГИСТРАЦИЯ ВСЕЙ ЛОГИКИ АВТОРИЗАЦИИ
registerAuthHandlers(bot, User, showMainMenu);

// Регистрируем админские хендлеры
registerAdminHandlers(bot, {
  User,
  Order,
  Product,
  Category,
  adminService,
  showAdminCategorySelection
});
// --- Главное меню ---
async function showMainMenu(ctx) {
  return ctx.reply('📋 Главное меню. Выберите действие:', Markup.keyboard([
    ['📦 Создать опись', '🧾 Мои отправления'],
    ['🔄 Изменить номер', '✏️ Мои черновики']
  ]).resize());
}

// --- Функция предпросмотра ---
async function showOrderPreview(ctx, user) {
  const items = user.currentOrder.map((i, idx) => {
      const itemTotal = i.total && !isNaN(i.total) ? i.total : 0; 
      return `${idx + 1}. ${i.product} — ${i.quantity}шт, всего *${itemTotal.toFixed(2)}€*`;
  }).join('\n');
  
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

// --- Обработчик кнопки "Создать опись" ---
bot.hears('📦 Создать опись', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder = [];
  user.currentStep = 'idle';
  user.lastOrderId = null; 
  await user.save();
  await showCategorySelection(ctx);
});

// --- Просмотр отправлений (Добавлены статус, трек и ссылка) ---
bot.hears('🧾 Мои отправления', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  let currentPhone = user.phone; 
  if (currentPhone && !currentPhone.startsWith('+')) {
      currentPhone = '+' + currentPhone; 
  }
  
  if (!currentPhone) return ctx.reply('⚠️ Пожалуйста, сначала привяжите номер телефона.');

  // Сортируем: новые сверху
  const orders = await Order.find({ 
      clientPhone: currentPhone, 
      status: { $ne: 'nuevo' } // Не показываем черновики
  }).sort({ createdAt: -1 });
  
  if (!orders.length) return ctx.reply(`📭 У вас пока нет отправлений, связанных с номером ${currentPhone}.`);

  let text = `📦 *Ваши отправления (по номеру ${currentPhone}):*\n\n`;

  orders.forEach((o, i) => {
     // Красивое форматирование даты
     const date = o.createdAt ? o.createdAt.toLocaleDateString() : 'Неизвестно';
     
     // Проверяем наличие трека и ссылки. 
     // Используем обратные кавычки ` ` для трека, чтобы его можно было скопировать кликом.
     const trackInfo = o.trackingNumber ? `\n🚛 Трек: \`${o.trackingNumber}\`` : '';
     const linkInfo = o.trackingUrl ? `\n🔗 [Отследить посылку](${o.trackingUrl})` : '';

     text += `🔹 *Заказ #${i + 1} от ${date}*\n`;
     text += `💰 Сумма: ${o.totalSum.toFixed(2)}€\n`;
     text += `🚦 Статус: *${o.status}*\n`; 
     text += `${trackInfo}${linkInfo}\n`;
     text += `──────────────────\n`;
  });

  // Добавляем disable_web_page_preview, чтобы ссылки не создавали огромные превью
  await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true });
});

// --- Просмотр черновиков ---
bot.hears('✏️ Мои черновики', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    let currentPhone = user.phone;
    
    if (!currentPhone) return ctx.reply('⚠️ Сначала привяжите номер телефона.');
    if (!currentPhone.startsWith('+')) currentPhone = '+' + currentPhone; 

    const drafts = await Order.find({ 
        clientPhone: currentPhone, 
        status: 'nuevo'
    }).sort({ createdAt: -1 });

    if (!drafts.length) return ctx.reply('🙌 У вас нет активных черновиков.');

    let text = '✏️ Ваши активные черновики (нажмите, чтобы редактировать):\n\n';
    
    const draftButtons = drafts.map((d, i) => {
        return [{ 
            text: `Черновик #${i + 1} от ${d.createdAt.toLocaleDateString()} (${d.totalSum.toFixed(2)}€)`, 
            callback_data: `edit_order_${d._id}` 
        }];
    });

    await ctx.reply(text, { reply_markup: { inline_keyboard: draftButtons } });
});

// --- Обработка добавления Custom Product ---
bot.action('add_custom_product', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'awaiting_custom_product'; 
    await user.save();
    return ctx.editMessageText('✍️ Введите название товара (например, Свеча ароматическая):');
});

// --- Выбор категории ---
bot.action(/cat_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const callbackData = ctx.match[0];
  if (callbackData.startsWith('select_cat_final_') || callbackData.startsWith('cat_final_')) {
      return; 
  }
  const categoryId = callbackData.split('_').pop();
  
  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    await ctx.answerCbQuery('⚠️ Ошибка: Некорректный ID.');
    return;
  }

  const category = await Category.findById(categoryId);
  const products = await Product.find({ categoryId }).sort({ name: 1 });
  
  const buttons = products.map(p => [{ text: p.name, callback_data: `prod_${p._id}` }]);
  const messageText = `📝 Вы выбрали категорию *${category.emoji} ${category.name}*. Выберите товар:`;
  
  await ctx.editMessageText(messageText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
  });
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
    user.currentOrder.push({ product: product.name, quantity: 0, total: 0 });    
    user.currentStep = 'awaiting_quantity';
    await user.save();
    await ctx.reply(`Введите количество для "${product.name}" (в штуках):`);
  }
});

// --- ТЕКСТОВЫЕ ОТВЕТЫ (ГЛАВНЫЙ РОУТЕР) ---
bot.on('text', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  const text = ctx.message.text.trim();

  // Логика автоматического определения номера (если нет телефона)
  if (!user || !user.phone) {
    const cleanedText = text.replace(/[^0-9+]/g, '');
    if (cleanedText.length >= 9 && /^[\d+]/.test(text)) {
      let formattedPhone = cleanedText;
      if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;

      user.phone = formattedPhone;
      user.currentStep = 'idle';
      await user.save();

      await ctx.reply(`✅ Ваш номер сохранён: ${formattedPhone}`);
      return showMainMenu(ctx);
    }
  }

  switch (user.currentStep) {
    
    // --- ПОЛЬЗОВАТЕЛЬ: Свой товар ---
    case 'awaiting_custom_product':
      user.currentOrder.push({ product: text, quantity: 0, total: 0 });
      user.currentStep = 'awaiting_quantity';
      await user.save();
      return ctx.reply('Введите количество:');

    // --- ПОЛЬЗОВАТЕЛЬ: Количество ---
    case 'awaiting_quantity':
      const qty = parseInt(text);
      if (!qty || qty <= 0) return ctx.reply('Введите корректное число.');
      
      // Защита от пустого массива заказов
      if (user.currentOrder.length === 0) {
          user.currentStep = 'idle';
          await user.save();
          return ctx.reply('⚠️ Произошла ошибка. Начните опись заново.');
      }

      user.currentOrder[user.currentOrder.length - 1].quantity = qty;
      user.currentStep = 'awaiting_total';
      await user.save();
      return ctx.reply('💰 Введите *общую сумму* за эту позицию (например, 19.99):', { parse_mode: 'Markdown' });

    // --- ПОЛЬЗОВАТЕЛЬ: Сумма ---
    case 'awaiting_total':
      const total = parseFloat(text.replace(',', '.'));
      if (isNaN(total) || total < 0) return ctx.reply('Введите корректную сумму.');
        
      user.currentOrder[user.currentOrder.length - 1].total = total;
      user.currentStep = 'confirm_order';
      await user.save();
      return showOrderPreview(ctx, user);

    case 'confirm_order':
      return ctx.reply('👇 Пожалуйста, используйте кнопки меню под сообщением с описью (Добавить, Отправить, Отменить).');

    case 'awaiting_new_phone':
      const cleanedPhone = text.replace(/[^0-9]/g, ''); 
      if (cleanedPhone.length < 9) {
         return ctx.reply('❌ Введите корректный номер телефона (минимум 9 цифр).');
      }

      let fPhone = text.trim();
      if (!fPhone.startsWith('+')) fPhone = '+' + fPhone;

      user.phone = fPhone;
      user.currentStep = 'idle';
      await user.save();
      
      await ctx.reply(`✅ Ваш новый номер сохранён: ${fPhone}`);
      return showMainMenu(ctx);

    default:
      return ctx.reply('🤔 Я не понимаю эту команду. Воспользуйтесь меню.');
  }
});

// --- Удаление из описи ---
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

// --- Добавить ещё ---
bot.action('add_more', async (ctx) => {
  await ctx.answerCbQuery();
  await showCategorySelection(ctx);
});

// --- Отмена ---
bot.action('cancel_order', async (ctx) => {
  await ctx.answerCbQuery();
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder = [];
  user.currentStep = 'idle';
  user.lastOrderId = null; 
  await user.save();
  await ctx.reply('❌ Опись отменена.');
  await showMainMenu(ctx);
});

// --- Сохранить как черновик (Предварительная отправка) ---
bot.action('send_order', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user || !user.currentOrder.length) return ctx.reply('Ошибка: нет товаров.');

    const total = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
    let currentPhone = user.phone;
    
    let order;

    if (user.lastOrderId) {
        const existingOrder = await Order.findById(user.lastOrderId);
        if (existingOrder && existingOrder.status === 'nuevo') {
            order = await Order.findByIdAndUpdate(user.lastOrderId, {
                clientPhone: currentPhone,
                items: user.currentOrder,
                totalSum: total,
            }, { new: true });
        }
    }

    if (!order) {
        order = await Order.create({
            userId: user._id,
            clientPhone: currentPhone,
            items: user.currentOrder,
            totalSum: total,
            status: 'nuevo' 
        });
    }

    user.currentOrder = [];
    user.currentStep = 'idle';
    user.lastOrderId = order._id; 
    await user.save();

    await ctx.editMessageText(
        `✅ Опись сохранена как *Черновик* (ID: ${order._id}). Вы можете её отредактировать.`,
        { 
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✏️ Редактировать', callback_data: `edit_order_${order._id}` }],
                    [{ text: '🚀 Окончательно отправить', callback_data: `final_send_${order._id}` }]
                ]
            }
        }
    );
});

// --- Редактирование ---
bot.action(/edit_order_.+/, async (ctx) => {
    await ctx.answerCbQuery('Загружаю черновик...');
    
    const orderId = ctx.match[0].replace('edit_order_', '');
    const order = await Order.findById(orderId);
    
    if (!order || order.status !== 'nuevo') {
        return ctx.editMessageText('⚠️ Этот заказ нельзя редактировать (он уже отправлен).', { reply_markup: {} });
    }
    
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    user.currentOrder = order.items;
    user.lastOrderId = orderId; 
    user.currentStep = 'confirm_order'; 
    await user.save();
    
    await ctx.editMessageText(`✏️ Вы вернулись к редактированию заказа ID ${orderId}.`);
    return showOrderPreview(ctx, user); 
});

// --- Финальная отправка ---
bot.action(/final_send_.+/, async (ctx) => {
    await ctx.answerCbQuery('Отправляю...');
    
    const orderId = ctx.match[0].replace('final_send_', '');
    const order = await Order.findById(orderId);

    if (!order || order.status !== 'nuevo') {
        return ctx.editMessageText('⚠️ Ошибка: Заказ не найден или уже отправлен.', { reply_markup: {} });
    }
    
    if (sheetsClient) {
        const totalOrder = order.totalSum;
        const itemsString = order.items.map(i => `${i.product} (${i.quantity}pc) (${i.total}€)`).join(', ');
        const values = [
            [new Date().toLocaleString(), order.clientPhone, itemsString, totalOrder]
        ];
        
        try {
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                range: 'Sheet1!A:D',
                valueInputOption: 'USER_ENTERED',
                requestBody: { values }
            });
        } catch (error) {
            console.error('Ошибка записи в Google Sheets:', error);
        }
    }

    order.status = 'en tramito';
    await order.save();
    
    await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastOrderId: null, currentStep: 'idle' });

    await ctx.editMessageText(`🚀 Опись ID ${orderId} *окончательно отправлена*!`, { 
        parse_mode: 'Markdown',
        reply_markup: {} 
    });
    await showMainMenu(ctx);
});

// --- Callback для всех остальных (ловит необработанные) ---
bot.on('callback_query', async (next) => {
    return next();
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте ещё раз.');
});

bot.launch();
console.log('🚀 Telegram bot started...');