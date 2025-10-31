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

// 🟢 РЕГИСТРАЦИЯ ВСЕЙ ЛОГИКИ АВТОРИЗАЦИИ
registerAuthHandlers(bot, User, showMainMenu);

// --- Middleware для проверки авторизации ---
// Передаем модель User в функцию middleware.
bot.use(checkAuth(User));

// --- Главное меню ---
async function showMainMenu(ctx) {
  return ctx.reply('📋 Главное меню. Выберите действие:', Markup.keyboard([
    ['📦 Создать опись', '🧾 Мои отправления'],
    ['🔄 Изменить номер', '✏️ Мои черновики']
  ]).resize());
}

// --- Старт создания описи ---
async function startNewOrder(ctx) {
  const categories = await Category.find();
  const buttons = categories.map(c => [{ text: `${c.emoji} ${c.name}`, callback_data: `cat_${c._id}` }]);
  await ctx.reply('Выберите категорию товара:', { reply_markup: { inline_keyboard: buttons } });
}

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
  // Стандартизация номера для поиска (для избежания "+7" vs "7")
  if (currentPhone && !currentPhone.startsWith('+')) {
      currentPhone = '+' + currentPhone; 
  }
  
  // ❌ Если телефона нет (теоретически невозможно из-за middleware), выходим
  if (!currentPhone) {
      return ctx.reply('⚠️ Пожалуйста, сначала привяжите номер телефона.');
  }

  // 3. Ищем заказы НАПРЯМУЮ по полю clientPhone в модели Order
  const orders = await Order.find({ 
      clientPhone: currentPhone, 
      status: { $ne: 'nuevo' } // 👈 ИСКЛЮЧАЕМ ЧЕРНОВИКИ
  }).sort({ timestamp: -1 });
  
  if (!orders.length) return ctx.reply(`📭 У вас пока нет отправлений, связанных с номером ${currentPhone}.`);

  let text = `📦 Ваши отправления (по номеру ${currentPhone}):\n\n`;
  orders.forEach((o, i) => {
     text += `#${i + 1} от ${o.timestamp.toLocaleString()} — ${o.totalSum.toFixed(2)}€\n`;
  });
    await ctx.reply(text);
});


// --- Просмотр активных черновиков ---
bot.hears('✏️ Мои черновики', async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    let currentPhone = user.phone;
    
    // Стандартизация номера
    if (!currentPhone) {
        return ctx.reply('⚠️ Сначала привяжите номер телефона.');
    }
    if (!currentPhone.startsWith('+')) {
        currentPhone = '+' + currentPhone; 
    }

    // 1. Ищем все заказы со статусом 'новое' по номеру телефона
    const drafts = await Order.find({ 
        clientPhone: currentPhone, 
        status: 'nuevo' // Только черновики
    }).sort({ timestamp: -1 });

    if (!drafts.length) {
        return ctx.reply('🙌 У вас нет активных черновиков.');
    }

    let text = '✏️ Ваши активные черновики (нажмите, чтобы редактировать):\n\n';
    
    // 2. Создаем кнопки для каждого черновика
    const draftButtons = drafts.map((d, i) => {
        return [{ 
            // Кнопка: "Черновик #1 от [дата] (Сумма)"
            text: `Черновик #${i + 1} от ${d.timestamp.toLocaleDateString()} (${d.totalSum.toFixed(2)}€)`, 
            // Используем уже существующий обработчик edit_order_...
            callback_data: `edit_order_${d._id}` 
        }];
    });

    await ctx.reply(text, {
        reply_markup: {
            inline_keyboard: draftButtons
        }
    });
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

// --- Подтверждение и отправка (Сохранить/Обновить Черновик) ---
bot.action('send_order', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await User.findOne({ telegramId: ctx.from.id });
    if (!user || !user.currentOrder.length) return ctx.reply('Ошибка: нет товаров.');

    const total = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
    const currentPhone = user.phone;
    
    let order;

    // 1. Проверяем, есть ли ID последнего черновика и не был ли он уже отправлен
    if (user.lastOrderId) {
        const existingOrder = await Order.findById(user.lastOrderId);

        // Если черновик существует и имеет статус 'nuevo' (не отправлен)
        if (existingOrder && existingOrder.status === 'nuevo') {
            // Обновляем существующий черновик
            order = await Order.findByIdAndUpdate(user.lastOrderId, {
                clientPhone: currentPhone,
                items: user.currentOrder,
                totalSum: total,
                // Статус остается 'nuevo'
            }, { new: true });
        }
    }

    // Если черновик не был обновлен (потому что lastOrderId не было или заказ был sent/cancelled)
    if (!order) {
        // 2. Создаем новый черновик
        order = await Order.create({
            userId: user._id,
            clientPhone: currentPhone,
            items: user.currentOrder,
            totalSum: total,
            status: 'nuevo' // Новый черновик всегда 'nuevo'
        });
    }

    // Очищаем временную корзину
    user.currentOrder = [];
    user.currentStep = 'idle';
    user.lastOrderId = order._id; // Обновляем/устанавливаем ID текущего черновика
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

// --- Редактирование заказа ---
bot.action(/edit_order_.+/, async (ctx) => {
    await ctx.answerCbQuery('Загружаю черновик для редактирования...');
    
    // Получаем ID заказа из callback_data
    const orderId = ctx.match[0].replace('edit_order_', '');
    
    // Ищем заказ
    const order = await Order.findById(orderId);
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    // Проверка, что заказ существует и является черновиком
    if (!order || order.status !== 'nuevo') {
        return ctx.editMessageText('⚠️ Этот заказ нельзя редактировать (он либо не существует, либо уже отправлен).', { reply_markup: {} });
    }
    
    // 1. Переносим содержимое заказа обратно во временную корзину пользователя
    user.currentOrder = order.items;
    user.lastOrderId = orderId; // Сохраняем ID редактируемого заказа
    user.currentStep = 'idle'; 
    await user.save();
    
    // 2. Обновляем сообщение, чтобы показать текущее состояние описи
    await ctx.editMessageText(`✏️ Вы вернулись к редактированию заказа ID ${orderId}. Добавьте или удалите позиции.`);

    // 3. Показываем предпросмотр, используя временную корзину
    return showOrderPreview(ctx, user); 
});

// --- Окончательная отправка заказа ---
bot.action(/final_send_.+/, async (ctx) => {
    await ctx.answerCbQuery('Отправляю заказ...');
    
    // Получаем ID заказа из callback_data
    const orderId = ctx.match[0].replace('final_send_', '');
    
    // Ищем заказ по ID
    const order = await Order.findById(orderId);

    // Проверка, что заказ существует и еще не был отправлен
    if (!order || order.status !== 'nuevo') {
        return ctx.editMessageText('⚠️ Ошибка: Заказ не найден или уже отправлен.', { reply_markup: {} });
    }
    
    // 1. Отправляем в Google Sheets
    if (sheetsClient) {
        const total = order.totalSum;
        const values = [
            [new Date().toLocaleString(), order.clientPhone, JSON.stringify(order.items), total]
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
            // Продолжаем, даже если Google Sheets не сработал
        }
    }

    // 2. Меняем статус на "отправлен"
    order.status = 'enviado'; 
    await order.save();
    
    // Обновляем сообщение в чате
    await ctx.editMessageText(`🚀 Опись ID ${orderId} *окончательно отправлена*! Изменения больше невозможны.`, { 
        parse_mode: 'Markdown',
        reply_markup: {} // Удаляем inline-кнопки
    });
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
