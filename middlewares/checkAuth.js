const { Markup } = require('telegraf');

// Функция для запроса номера телефона
function requestPhone(ctx) {
 return ctx.reply('📞 Отправьте контакт (кнопкой ниже) или введите номер в формате +34612345678:',
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

    // Пропускаем контактное сообщение (бот получает его напрямую)
    if (ctx.message && ctx.message.contact) {
        return next(); 
    }

    const user = await User.findOne({ telegramId });

    // Пропускаем команду "✍️ Ввести другой номер"
    if (ctx.message && ctx.message.text === '✍️ Ввести другой номер') {
        return next();
    }
    
    // Пропускаем ЛЮБОЙ текст, если пользователь уже в режиме ввода номера
    if (user && user.currentStep === 'awaiting_new_phone' && ctx.message && ctx.message.text) {
        return next();
    }

    // --- ПРОВЕРКА АВТОРИЗАЦИИ ---
    // Если нет пользователя ИЛИ нет телефона, НО пользователь НЕ в режиме ввода
    if (!user || (!user.phone && user.currentStep !== 'awaiting_new_phone')) {
        if (ctx.updateType === 'message' || ctx.updateType === 'callback_query') {
            return requestPhone(ctx);
        }
    }
    
    next();
};

module.exports = {
  checkAuth,
  requestPhone
};