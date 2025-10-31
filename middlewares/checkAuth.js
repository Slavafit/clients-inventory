const { Markup } = require('telegraf');

// Функция для запроса номера телефона
function requestPhone(ctx) {
 return ctx.reply('⚠️ Для продолжения работы, пожалуйста, отправьте свой номер телефона:',
    Markup.keyboard([
        [Markup.button.contactRequest('📱 Поделиться текущим номером')],
         ['✍️ Ввести другой номер']
     ]).oneTime().resize()
 );
}

// Главная функция Middleware
const checkAuth = (User) => async (ctx, next) => {
    const telegramId = ctx.from.id || (ctx.callbackQuery && ctx.callbackQuery.from.id);
    
    if (!telegramId) {
        console.error('Не удалось определить Telegram ID пользователя.');
        return; 
    }

    // 1. Пропускаем контактное сообщение (bot.on('contact'))
    if (ctx.message && ctx.message.contact) {
        return next(); 
    }

    const user = await User.findOne({ telegramId });

    // 2. Пропускаем команду "✍️ Ввести другой номер"
    if (ctx.message && ctx.message.text === '✍️ Ввести другой номер') {
        return next();
    }
    
    // 3. Пропускаем ЛЮБОЙ текстовый ввод, если пользователь находится в режиме ожидания номера
    if (user && user.currentStep === 'awaiting_new_phone' && ctx.message && ctx.message.text) {
        return next();
    }

    // --- ПРОВЕРКА АВТОРИЗАЦИИ ---
    // Если пользователя нет ИЛИ он не предоставил номер
    if (!user || !user.phone) {
        // Для всех остальных сообщений (команды, произвольный текст) просим телефон
        if (ctx.updateType === 'message' || ctx.updateType === 'callback_query') {
            return requestPhone(ctx);
        }
    }
    
    // Телефон есть, передаем управление следующему обработчику
    next();
};

module.exports = {
  checkAuth,
  requestPhone
};