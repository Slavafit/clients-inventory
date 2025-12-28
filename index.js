require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const fs = require('fs');

const Category = require('./models/Category');
const Product = require('./models/Product');
const User = require('./models/User');
const Order = require('./models/Order');
const adminService = require('./services/adminService');
const { checkAuth } = require('./middlewares/checkAuth');
const { checkAdmin } = require('./middlewares/checkAdmin');
const { registerAuthHandlers } = require('./handlers/auth');
const { callbackDebug } = require('./middlewares/callbackDebug');
const { 
        showCategorySelection, 
        showAdminCategorySelection 
    } = require('./handlers/category');
const { INSTRUCTIONS_TEXT } = require('./data/texts');

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

// 🟢 РЕГИСТРАЦИЯ ЛОГИКИ АВТОРИЗАЦИИ
registerAuthHandlers(bot, User, showMainMenu);

// --- Middleware ---
bot.use(checkAuth(User));
bot.use(callbackDebug());

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

// --- Обработчик для установки роли администратора (ТОЛЬКО ДЛЯ ПЕРВОНАЧАЛЬНОЙ НАСТРОЙКИ!) ---
//Установите свой Telegram ID в BOT_ADMIN_ID в .env файле
// bot.command('setadmin', async (ctx) => {
//   if (ctx.from.id.toString() === process.env.BOT_ADMIN_ID) {
//       await User.findOneAndUpdate({ telegramId: ctx.from.id }, { role: 'admin' }, { upsert: true });
//       return ctx.reply('🎉 Вы назначены администратором!');
//   }
//   return ctx.reply('⛔ Недостаточно прав.');
// });

bot.command('makeadmin', async (ctx) => {
    if (ctx.from.id !== Number(process.env.ADMIN_ID)) return;

    const targetId = ctx.message.text.split(' ')[1];
    if (!targetId) return ctx.reply('Введите ID: /makeadmin 123456');

    await User.findOneAndUpdate({ telegramId: targetId }, { role: 'admin' });
    ctx.reply(`✅ Пользователь ${targetId} теперь админ.`);
});

//инструкции
bot.command('help', checkAuth(User), async (ctx) => {
    const sentMessage = await ctx.reply(INSTRUCTIONS_TEXT, { parse_mode: 'Markdown' });
    try {
        await ctx.pinChatMessage(sentMessage.message_id);
    } catch (e) {
        console.error(`[ERROR] Не удалось закрепить сообщение: ${e.message}`);
    }
});

// --- Админские команды ---
bot.command('addcat', checkAdmin(User), async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentStep = 'awaiting_category_name';
  await user.save();
  return ctx.reply('📝 Введите название новой категории:');
});

bot.command('addprod', checkAdmin(User), async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentStep = 'awaiting_product_name';
  user.tempProductName = null;
  user.tempCategoryId = null;
  await user.save();
  return ctx.reply('📝 Введите **название** нового товара:', { parse_mode: 'Markdown' });
});

// 1. Вход в режим поиска
bot.command('admin', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (user?.role !== 'admin' && ctx.from.id !== Number(process.env.ADMIN_ID)) return;

    user.currentStep = 'admin_search_client';
    await user.save();
    ctx.reply('🔍 Введите номер телефона клиента (с +) для поиска заказа:');
});


// Обработка кнопки "Установить трек"
bot.action(/admin_set_track_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'admin_awaiting_track';
    user.tempOrderId = orderId;
    await user.save();
    ctx.reply('Введите трек-номер для этого заказа:');
});



bot.on('callback_query', async (ctx, next) => {
    return next();
});

// --- Обработчик кнопки "Создать опись" ---
bot.hears('📦 Создать опись', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  user.currentOrder = [];
  user.currentStep = 'idle';
  user.lastOrderId = null; // 🔥 ИСПРАВЛЕНИЕ: Сбрасываем ID старого черновика, чтобы не перезаписать его
  await user.save();
  await showCategorySelection(ctx);
});

// --- 🔥 ИСПРАВЛЕНИЕ: Добавлен отсутствующий обработчик смены номера ---
bot.hears('🔄 Изменить номер', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'awaiting_new_phone';
    await user.save();
    return ctx.reply('📱 Введите ваш новый номер телефона (например: +34123456789):');
});

// --- Просмотр отправлений ---
bot.hears('🧾 Мои отправления', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  let currentPhone = user.phone; 
  if (currentPhone && !currentPhone.startsWith('+')) {
      currentPhone = '+' + currentPhone; 
  }
  
  if (!currentPhone) return ctx.reply('⚠️ Пожалуйста, сначала привяжите номер телефона.');

  const orders = await Order.find({ 
      clientPhone: currentPhone, 
      status: { $ne: 'nuevo' }
  }).sort({ timestamp: -1 });
  
  if (!orders.length) return ctx.reply(`📭 У вас пока нет отправлений, связанных с номером ${currentPhone}.`);

  let text = `📦 Ваши отправления (по номеру ${currentPhone}):\n\n`;
  orders.forEach((o, i) => {
     text += `#${i + 1} от ${o.timestamp.toLocaleString()} — ${o.totalSum.toFixed(2)}€\n`;
  });
  await ctx.reply(text);
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
    }).sort({ timestamp: -1 });

    if (!drafts.length) return ctx.reply('🙌 У вас нет активных черновиков.');

    let text = '✏️ Ваши активные черновики (нажмите, чтобы редактировать):\n\n';
    
    const draftButtons = drafts.map((d, i) => {
        return [{ 
            text: `Черновик #${i + 1} от ${d.timestamp.toLocaleDateString()} (${d.totalSum.toFixed(2)}€)`, 
            callback_data: `edit_order_${d._id}` 
        }];
    });

    await ctx.reply(text, { reply_markup: { inline_keyboard: draftButtons } });
});

// --- Обработка добавления Custom Product ---
bot.action('add_custom_product', checkAuth(User), async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'awaiting_custom_product'; 
    await user.save();
    return ctx.editMessageText('✍️ Введите название товара (например, Свеча ароматическая):');
});

// --- Админ: Финальное добавление товара ---
bot.action(/cat_final_.+|select_cat_final_.+/, checkAdmin(User), async (ctx) => {    
    await ctx.answerCbQuery(); 

    const callbackData = ctx.match[0];
    const categoryId = callbackData.split('_').pop();

    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
        return ctx.editMessageText(`⚠️ Ошибка ID.`);
    }

    try {
        const user = await User.findOne({ telegramId: ctx.from.id });
        const productName = user.tempProductName;
        
        if (!productName) {
            user.currentStep = 'idle';
            await user.save();
            return ctx.editMessageText('⚠️ Ошибка: Название товара потеряно.');
        }
        
        const category = await Category.findById(categoryId);
        if (!category) {
            user.currentStep = 'idle';
            await user.save();
            return ctx.editMessageText('⚠️ Ошибка: Категория не найдена.');
        }

        const newProduct = await Product.create({
            categoryId: categoryId,
            name: productName
        });

        user.tempProductName = null; 
        user.currentStep = 'idle';
        await user.save();
        await ctx.editMessageText(`✅ Товар *${newProduct.name}* успешно добавлен в категорию *${category.name}*!`, { parse_mode: 'Markdown' });
        
    } catch (error) {
        console.error('CRITICAL ERROR in add product:', error);
        return ctx.editMessageText('❌ Ошибка при сохранении товара.');
    }
});

// --- Выбор категории ---
bot.action(/cat_.+/, async (ctx) => {
  await ctx.answerCbQuery();
  const callbackData = ctx.match[0];
  // Защита от перехвата админских команд
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

// --- Текстовые ответы ---
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
    //  Обработка поиска и вывод заказа
    case 'admin_search_client':
            const order = await Order.findOne({ clientPhone: text.trim() }).sort({ createdAt: -1 });
      if (!order) return ctx.reply('❌ Заказ не найден.');

      user.tempOrderId = order._id; // Сохраняем ID заказа для админа
      user.currentStep = 'idle';
      await user.save();

      ctx.reply(
          `📄 Заказ от: ${order.createdAt.toLocaleDateString()}\n` +
          `Статус: ${order.status}\n` +
          `Сумма: ${order.totalSum}€\n` +
          `Трек: ${order.trackingNumber || 'нет'}\n\n` +
          `Выберите действие:`,
          Markup.inlineKeyboard([
              [Markup.button.callback('📦 Установить трек', `admin_set_track_${order._id}`)],
              [Markup.button.callback('✅ Завершить (Entregado)', `admin_status_delivered_${order._id}`)]
          ])
      );
      // Шаг: Админ ввел трек-номер
    case 'admin_awaiting_track':
        user.tempTrackNumber = text.trim(); // Сохраняем номер в базу
        user.currentStep = 'admin_awaiting_track_link'; // Переходим к следующему шагу
        await user.save();
        
        return ctx.reply('🔗 Шаг 2: Теперь введите ссылку на сервис отслеживания (или напишите "нет", если ссылки нет):');
      // Шаг: Админ ввел ссылку
    case 'admin_awaiting_track_link':
          const link = text.toLowerCase().trim() === 'нет' ? '' : text.trim();
          // Простая валидация ссылки (опционально)
        if (link && !link.startsWith('http')) {
            return ctx.reply('⚠️ Ссылка должна начинаться с http или https. Попробуйте снова или напишите "нет".');
        }

        // Вызываем общий сервис (adminService.js)
        // Он сам обновит статус, сохранит данные и уведомит клиента (TG или WA)
        try {
            await adminService.setTracking(
                user.tempAdminOrderId, 
                { number: user.tempTrackNumber, url: link }, 
                { bot } // Передаем bot для отправки уведомлений в TG
            );

            // Сброс состояния админа
            user.currentStep = 'idle';
            user.tempTrackNumber = null;
            user.tempAdminOrderId = null;
            await user.save();

            return ctx.reply('✅ Трек-номер и ссылка сохранены. Клиент уведомлен.');
        } catch (err) {
            console.error(err);
            user.currentStep = 'idle'; // Сбрасываем при ошибке, чтобы не застрять
            await user.save();
            return ctx.reply('❌ Произошла ошибка при сохранении трека.');
        }
        // 🆕 АДМИН: Ожидание названия товара
    case 'awaiting_product_name':
      user.tempProductName = text;
      user.currentStep = 'awaiting_category_selection';
      await user.save(); 
      return showAdminCategorySelection(ctx);

    case 'awaiting_category_selection':
     user.currentStep = 'idle';
     await user.save();
     return ctx.reply('❌ Ожидался выбор категории кнопкой. Действие отменено.');

    case 'idle':
     return showMainMenu(ctx);

    case 'awaiting_category_name':
      const newCategory = await Category.create({ name: text });
      user.currentStep = 'idle';
      await user.save();
      return ctx.reply(`✅ Категория "${newCategory.name}" успешно добавлена!`);
    // АДМИН: Ожидание названия товара
    case 'awaiting_custom_product':
      user.currentOrder.push({ product: text, quantity: 0, total: 0 });
      user.currentStep = 'awaiting_quantity';
      await user.save();
      return ctx.reply('Введите количество:');

    case 'awaiting_quantity':
      const qty = parseInt(text);
      if (!qty || qty <= 0) return ctx.reply('Введите корректное число.');
      user.currentOrder[user.currentOrder.length - 1].quantity = qty;
      user.currentStep = 'awaiting_total';
      await user.save();
      return ctx.reply('💰 Введите *общую сумму* за эту позицию (например, 19.99):', { parse_mode: 'Markdown' });

    case 'awaiting_total':
      const total = parseFloat(text.replace(',', '.'));
      if (isNaN(total) || total < 0) return ctx.reply('Введите корректную сумму.');
        
      user.currentOrder[user.currentOrder.length - 1].total = total;
      user.currentStep = 'confirm_order';
      await user.save();
      return showOrderPreview(ctx, user);

    // 🔥 ИСПРАВЛЕНИЕ: Обработка случая, если юзер пишет текст, когда мы ждем нажатия кнопок меню
    case 'confirm_order':
      return ctx.reply('👇 Пожалуйста, используйте кнопки меню под сообщением с описью (Добавить, Отправить, Отменить).');

    case 'awaiting_new_phone':
      const cleanedText = text.replace(/[^0-9]/g, ''); 
      if (cleanedText.length < 9) {
         return ctx.reply('❌ Введите корректный номер телефона (минимум 9 цифр).');
      }

      let formattedPhone = text.trim();
      if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;

      user.phone = formattedPhone;
      user.currentStep = 'idle';
      await user.save();
      
      await ctx.reply(`✅ Ваш новый номер сохранён: ${formattedPhone}`);
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
  user.lastOrderId = null; // 🔥 ИСПРАВЛЕНИЕ: Сбрасываем привязку к черновику
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

    // 🔥 ИСПРАВЛЕНИЕ: Проверяем, существует ли черновик СЕЙЧАС (не был ли он удален или отправлен в другой сессии)
    if (user.lastOrderId) {
        const existingOrder = await Order.findById(user.lastOrderId);
        // Если черновик найден и он все еще 'nuevo'
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
    
    // Проверка статуса
    if (!order || order.status !== 'nuevo') {
        return ctx.editMessageText('⚠️ Этот заказ нельзя редактировать (он уже отправлен).', { reply_markup: {} });
    }
    
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    // Восстанавливаем состояние
    user.currentOrder = order.items;
    user.lastOrderId = orderId; 
    user.currentStep = 'confirm_order'; // 🔥 ИСПРАВЛЕНИЕ: Ставим правильный статус, чтобы бот знал где мы
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
        const total = order.totalSum;
        const itemsString = order.items.map(i => `${i.product} (${i.quantity}шт)`).join(', ');
        const values = [
            [new Date().toLocaleString(), order.clientPhone, itemsString, total]
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

    // 2. Меняем статус на "в работе"
    order.status = 'en tramito';
    await order.save();
    
    // 🔥 ИСПРАВЛЕНИЕ: Очищаем lastOrderId у пользователя, чтобы он случайно не перезаписал этот отправленный заказ
    await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastOrderId: null, currentStep: 'idle' });

    await ctx.editMessageText(`🚀 Опись ID ${orderId} *окончательно отправлена*!`, { 
        parse_mode: 'Markdown',
        reply_markup: {} 
    });
    await showMainMenu(ctx);
});

// --- Callback для всех остальных ---
bot.on('callback_query', async (ctx, next) => {
    return next();
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте ещё раз.');
});

bot.launch();
console.log('🚀 Telegram bot started...');