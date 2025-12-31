const { Markup } = require('telegraf');
const { checkAdmin } = require('../middlewares/checkAdmin');
const { checkAuth } = require('../middlewares/checkAuth');
const { INSTRUCTIONS_TEXT } = require('../data/texts');

// 🔥 Добавили showMainMenu и showAdminCategorySelection в аргументы функции
module.exports = function registerAdminHandlers(bot, { 
    User, 
    Order, 
    Product, 
    Category, 
    adminService,
    showAdminCategorySelection 
}) {
    
  // --- Команда назначения админа ---
  bot.command('makeadmin', checkAdmin(User), async (ctx) => {
      if (ctx.from.id !== Number(process.env.ADMIN_ID)) return;
      const targetId = ctx.message.text.split(' ')[1];
      if (!targetId) return ctx.reply('Введите ID: /makeadmin 123456');
      await User.findOneAndUpdate({ telegramId: targetId }, { role: 'admin' });
      ctx.reply(`✅ Пользователь ${targetId} теперь админ.`);
  });

  // --- Инструкции ---
  bot.command('help', checkAuth(User), async (ctx) => {
      const sentMessage = await ctx.reply(INSTRUCTIONS_TEXT, { parse_mode: 'Markdown' });
      try { await ctx.pinChatMessage(sentMessage.message_id); } catch (e) {}
  });

  // --- Команда /admin ---
  bot.command('admin', checkAdmin(User), async (ctx) => {
      const user = await User.findOne({ telegramId: ctx.from.id });
      user.currentStep = 'admin_search_client';
      await user.save();
      ctx.reply('🔍 Введите номер телефона клиента (с +) для поиска заказа:');
  });

  // --- Добавление товара ---
  bot.command('addprod', checkAdmin(User), async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'awaiting_product_name';
    await user.save();
    await ctx.reply('✏️ Введите название нового товара:');
  });

  // --- Добавление категории ---
  bot.command('addcat', checkAdmin(User), async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'awaiting_category_name';
    await user.save();
    await ctx.reply('✏️ Введите название новой категории:');
  });

  // --- Изменение статуса ---
  bot.action(/^set_status_(.+)_(.+)$/, checkAdmin(User), async (ctx) => {
    const status = ctx.match[1];
    const orderId = ctx.match[2];
    try {
      await adminService.updateStatus(orderId, status);
      await ctx.answerCbQuery('Готово');
      await ctx.editMessageText(`✅ Статус заказа изменён на *${status}*`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery('Ошибка');
      await ctx.reply('❌ Не удалось изменить статус заказа.');
    }
  });

  // --- Установить трек ---
  bot.action(/admin_set_track_(.+)/, checkAdmin(User), async (ctx) => {
      await ctx.answerCbQuery();
      const orderId = ctx.match[1];
      const user = await User.findOne({ telegramId: ctx.from.id });
      
      user.currentStep = 'admin_awaiting_track';
      user.tempOrderId = orderId; 
      await user.save();
      
      ctx.reply('✍️ Введите трек-номер для этого заказа:');
  });

  // --- Выбор категории для товара ---
  bot.action(/^admin_choose_cat_/, checkAdmin(User), async (ctx) => {
    await ctx.answerCbQuery();
    const catId = ctx.callbackQuery.data.split('_')[3];
    const category = await Category.findById(catId);
    const user = await User.findOne({ telegramId: ctx.from.id });

    if (!category || !user.newProductName) {
      return ctx.reply('⚠️ Ошибка. Начните с /addprod');
    }

    await Product.create({ name: user.newProductName, category: category._id });

    user.currentStep = 'idle'; // Исправлено: лучше 'idle' чем null, чтобы свитч работал
    user.newProductName = null;
    await user.save();

    await ctx.reply(`✅ Товар добавлен в категорию *${category.name}*`, { parse_mode: 'Markdown' });
  });

  // --- Завершить (Entregado) ---
  bot.action(/admin_status_delivered_(.+)/, checkAdmin(User), async (ctx) => {
      await ctx.answerCbQuery();
      const orderId = ctx.match[1];
      
      try {
          const order = await Order.findByIdAndUpdate(orderId, { status: 'entregado' }, { new: true });
          
          if (order) {
              try {
                  const clientUser = await User.findById(order.userId);
                  if (clientUser && clientUser.telegramId) {
                      // 🔥 Безопасная дата
                      const dateStr = (order.createdAt) ? (order.createdAt).toLocaleDateString() : '???';
                      await bot.telegram.sendMessage(clientUser.telegramId, `✅ Ваш заказ от ${dateStr} был доставлен (Entregado)! Спасибо.`);
                  }
              } catch (e) { console.log('Не удалось уведомить клиента'); }
              
              await ctx.editMessageText(`✅ Заказ ${orderId} помечен как ДОСТАВЛЕННЫЙ.`);
          } else {
              await ctx.reply('❌ Заказ не найден.');
          }
      } catch (err) {
          console.error(err);
          await ctx.reply('❌ Ошибка при обновлении статуса.');
      }
  });

  // 🔥 ОБРАБОТЧИК ТЕКСТА
  bot.on('text', async (ctx, next) => {
      const user = await User.findOne({ telegramId: ctx.from.id });      
      
      // Если админ просто пишет текст, но не находится в админском шаге — тоже пропускаем
      // (вдруг он хочет создать опись для себя)
      const adminSteps = [
          'admin_search_client', 
          'admin_awaiting_track', 
          'awaiting_product_name', 
          'awaiting_category_name'
      ];
      
            // 🛑 Если это не админ — пропускаем сообщение дальше (к обычным хендлерам)
      if (!user || user.role !== 'admin' || !adminSteps.includes(user.currentStep)) {
          return next();
      }

      const text = ctx.message.text.trim();

      switch (user.currentStep) {
          // --- АДМИН: Поиск заказа ---
          case 'admin_search_client':
              const order = await Order.findOne({ clientPhone: text }).sort({ createdAt: -1 });
              if (!order) return ctx.reply('❌ Заказ не найден, повторите ввод.');
      
              user.tempOrderId = order._id;
              user.currentStep = 'idle';
              await user.save();
              // Отправляем карточку
              const dateStr = (order.createdAt) ? (order.createdAt).toLocaleDateString() : 'Дата не указана';
      
              ctx.reply(
                  `📄 Заказ найден!\n` +
                  `📅 Дата: ${dateStr}\n` +
                  `🚦 Статус: ${order.status || 'nuevo'}\n` +
                  `💰 Сумма: ${(order.totalSum || 0).toFixed(2)}€\n` +
                  `🚛 Трек: ${order.trackingNumber || 'нет'}\n\n` +
                  `Выберите действие:`,
                  Markup.inlineKeyboard([
                    [Markup.button.callback('⏳ В обработке', `set_status_en tramito_${order._id}`)],
                    [Markup.button.callback('📦 Установить трек', `admin_set_track_${order._id}`)],
                    [Markup.button.callback('✅ Завершить (Entregado)', `admin_status_delivered_${order._id}`)]
                  ])
              );
              return;
      
          // --- АДМИН: Ввод трека (Авто-ссылка) ---
          case 'admin_awaiting_track': {
              const trackNumber = text; // Убрали toLowerCase, вдруг трек чувствителен к регистру
      
              if (!trackNumber || trackNumber.length < 5) {
                  return ctx.reply('⚠️ Введите корректный трек-номер.');
              }
      
              // Генерируем ссылку
              const trackingUrl = `https://parcelsapp.com/es/tracking/${trackNumber}`;
      
              try {
                  await adminService.setTracking(
                      user.tempOrderId,
                      {
                          number: trackNumber, // В adminService ожидается поле 'number', а не 'trackNumber'
                          url: trackingUrl
                      },
                      { bot }
                  );
      
                  user.currentStep = 'idle';
                  user.tempTrackNumber = null;
                  user.tempOrderId = null;
                  await user.save();
      
                  return ctx.reply('✅ Трек-номер сохранён. Клиент уведомлен.');
              } catch (err) {
                  console.error(err);
                  user.currentStep = 'idle';
                  await user.save();
                  return ctx.reply('❌ Ошибка при сохранении трека.');
              }
          }
      
          // --- АДМИН: Название товара ---
          case 'awaiting_product_name':
            user.newProductName = text;
            user.currentStep = 'awaiting_category_selection';
            await user.save(); 
            // 🔥 Вызов переданной функции
            return showAdminCategorySelection(ctx);
      
          // --- АДМИН: Категория текстом (ошибка) ---
          case 'awaiting_category_selection':
           user.currentStep = 'idle';
           await user.save();
           return ctx.reply('❌ Ожидался выбор категории кнопкой. Действие отменено.');

          // --- АДМИН: Создание категории ---
          case 'awaiting_category_name':
            const newCategory = await Category.create({ name: text });
            user.currentStep = 'idle';
            await user.save();
            return ctx.reply(`✅ Категория "${newCategory.name}" успешно добавлена!`);
      
          // По умолчанию (если шаг idle) — пропускаем дальше
          default:
           return next();
      }
    });
};