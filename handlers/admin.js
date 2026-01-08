const { Markup } = require('telegraf');
const { checkAdmin } = require('../middlewares/checkAdmin');
const { checkAuth } = require('../middlewares/checkAuth');
const { INSTRUCTIONS_TEXT } = require('../data/texts');

module.exports = function registerAdminHandlers(bot, { 
    User, 
    Order, 
    Product, 
    Category, 
    adminService,
    showAdminCategorySelection 
}) {
    
  // --- 1. Команда назначения админа ---
  bot.command('makeadmin', checkAdmin(User), async (ctx) => {
      if (ctx.from.id !== Number(process.env.ADMIN_ID)) return;
      const targetId = ctx.message.text.split(' ')[1];
      if (!targetId) return ctx.reply('Введите ID: /makeadmin 123456');
      await User.findOneAndUpdate({ telegramId: targetId }, { role: 'admin' });
      ctx.reply(`✅ Пользователь ${targetId} теперь админ.`);
  });

  // --- 2. Помощь ---
  bot.command('help', checkAuth(User), async (ctx) => {
      const sentMessage = await ctx.reply(INSTRUCTIONS_TEXT, { parse_mode: 'Markdown' });
      try { await ctx.pinChatMessage(sentMessage.message_id); } catch (e) {}
  });

  // --- 3. Поиск заказа (/admin) ---
  bot.command('admin', checkAdmin(User), async (ctx) => {
      const user = await User.findOne({ telegramId: ctx.from.id });
      user.currentStep = 'admin_search_client'; // Устанавливаем шаг поиска
      await user.save();
      ctx.reply('🔍 Введите номер телефона клиента (с +) для поиска заказа:');
  });

  // --- 4. Добавление товара (/addprod) ---
  bot.command('addprod', checkAdmin(User), async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'awaiting_product_name'; // Устанавливаем шаг ввода имени
    await user.save();
    await ctx.reply('✏️ Введите название нового товара:');
  });

  // --- 5. Добавление категории (/addcat) ---
  bot.command('addcat', checkAdmin(User), async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    user.currentStep = 'awaiting_category_name'; // Устанавливаем шаг ввода категории
    await user.save();
    await ctx.reply('✏️ Введите название новой категории:');
  });

  // --- КНОПКИ (Действия с заказом) ---
  
  // Статус
  bot.action(/^set_status_(.+)_(.+)$/, checkAdmin(User), async (ctx) => {

    const Newstatus = ctx.match[1];
    const orderId = ctx.match[2];
    try {
      await adminService.updateStatus(orderId, Newstatus, {
      bot
    });
      await ctx.answerCbQuery('Статус изменен и клиент уведомлен');
      await ctx.editMessageText(
        `✅ Статус заказа *#${orderId.toString().slice(-4)}* изменён на: *${Newstatus.toUpperCase()}*`,
        { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(err);
      await ctx.answerCbQuery('Ошибка');
    }
  });

  // Трек
  bot.action(/admin_set_track_(.+)/, checkAdmin(User), async (ctx) => {
      await ctx.answerCbQuery();
      const orderId = ctx.match[1];
      const user = await User.findOne({ telegramId: ctx.from.id });
      
      user.currentStep = 'admin_awaiting_track';
      user.tempOrderId = orderId; 
      await user.save();
      
      ctx.reply('✍️ Введите трек-номер для этого заказа:');
  });

  // Выбор категории (для товара)
  bot.action(/^admin_choose_cat_/, checkAdmin(User), async (ctx) => {
    await ctx.answerCbQuery();
    const catId = ctx.callbackQuery.data.split('_')[3];
    const category = await Category.findById(catId);
    const user = await User.findOne({ telegramId: ctx.from.id });

    if (!category || !user.newProductName) {
      return ctx.reply('⚠️ Ошибка. Начните с /addprod');
    }

    await Product.create({ name: user.newProductName, category: category._id });

    user.currentStep = 'idle';
    user.newProductName = null;
    await user.save();

    await ctx.reply(`✅ Товар добавлен в категорию *${category.name}*`, { parse_mode: 'Markdown' });
  });

  // ✅ Завершить (Entregado)
bot.action(/admin_status_delivered_(.+)/, checkAdmin(User), async (ctx) => {
    await ctx.answerCbQuery();

    const orderId = ctx.match[1];

    try {
        await adminService.updateStatus(orderId, 'Entregado', {
            bot
        });

        await ctx.editMessageText(`✅ Заказ ${orderId} помечен как *ДОСТАВЛЕННЫЙ*.`, {
            parse_mode: 'Markdown'
        });

    } catch (err) {
        console.error('Ошибка смены статуса:', err.message);
        await ctx.reply('❌ Не удалось изменить статус заказа.');
    }
});


  // 🔥 САМОЕ ВАЖНОЕ: ОБРАБОТЧИК ТЕКСТА (Логика шагов)
  bot.on('text', async (ctx, next) => {
      // 1. ЕСЛИ ЭТО КОМАНДА (начинается с /) — ИГНОРИРУЕМ этот обработчик
      // Это позволяет командам /start, /addprod, /admin работать нормально
      if (ctx.message.text.startsWith('/')) {
          return next();
      }

      // 2. Проверяем пользователя
      const user = await User.findOne({ telegramId: ctx.from.id.toString() });
      
      const adminSteps = [
          'admin_search_client', 
          'admin_awaiting_track', 
          'awaiting_product_name', 
          'awaiting_category_name'
      ];
      
      // Если не админ или не в нужном шаге — пропускаем
      if (!user || user.role !== 'admin' || !adminSteps.includes(user.currentStep)) {
          return next();
      }

      const text = ctx.message.text.trim();

      switch (user.currentStep) {
          // --- Логика поиска заказа ---
          case 'admin_search_client':
              const order = await Order.findOne({ clientPhone: text }).sort({ createdAt: -1 });
              if (!order) return ctx.reply('❌ Заказ не найден. Проверьте номер.');
      
              user.tempOrderId = order._id;
              user.currentStep = 'idle';
              await user.save();
      
              const dateStr = (order.createdAt ) ? (order.createdAt ).toLocaleDateString() : '???';
              ctx.reply(
                  `📄 Заказ найден!\n📅 ${dateStr}\n💰 ${order.totalSum}€\n🚦 ${order.status}`,
                  Markup.inlineKeyboard([
                    [Markup.button.callback('⏳ В обработке', `set_status_en_tramito_${order._id}`)],
                    [Markup.button.callback('📦 Установить трек', `admin_set_track_${order._id}`)],
                    [Markup.button.callback('✅ Завершить', `admin_status_delivered_${order._id}`)]
                  ])
              );
              return; // Выходим, не вызываем next()
      
          // --- Логика трека ---
          case 'admin_awaiting_track':
              if (text.length < 3) return ctx.reply('⚠️ Короткий трек.');
              
              const trackingUrl = `https://parcelsapp.com/es/tracking/${text}`;
              try {

                await adminService.setTracking(user.tempOrderId, { trackNumber: text, url: trackingUrl }, { bot });
                  user.currentStep = 'idle';
                  user.tempTrackNumber = null;
                  user.tempOrderId = null;
                  await user.save();
                  return ctx.reply('✅ Трек сохранён, ссылка сгенерирована.');
              } catch (err) {
                  user.currentStep = 'idle';
                  await user.save();
                  return ctx.reply('❌ Ошибка.');
              }
      
          // --- Логика названия товара ---
          case 'awaiting_product_name':
            user.newProductName = text; // Сохраняем то, что ввел админ
            user.currentStep = 'awaiting_category_selection';
            await user.save(); 
            // Показываем кнопки категорий
            return showAdminCategorySelection(ctx);
      
          // --- Логика названия категории ---
          case 'awaiting_category_name':
            const newCategory = await Category.create({ name: text });
            user.currentStep = 'idle';
            await user.save();
            return ctx.reply(`✅ Категория "${newCategory.name}" добавлена!`);

          default:
           return next();
      }
    });
};