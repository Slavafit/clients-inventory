const { Markup } = require('telegraf');
const { requestPhone } = require('../middlewares/checkAuth'); // Импортируем функцию запроса

// --- ФУНКЦИЯ ДЛЯ ПРОВЕРКИ И СОХРАНЕНИЯ КОНТАКТА ---
const handleContact = (User, showMainMenu) => async (ctx) => {
    let phone = ctx.message.contact.phone_number;
    await User.findOneAndUpdate({ telegramId: ctx.from.id }, { phone });
    
    // 🟢 ДОБАВЛЯЕМ + ПРИ СОХРАНЕНИИ
    if (!phone.startsWith('+')) {
        phone = '+' + phone;
    }
    
    // Удаляем временную клавиатуру запроса контакта
    await ctx.reply(`Ваш номер сохранён: ${phone}`, Markup.removeKeyboard());
    
    return showMainMenu(ctx);
};

// --- ФУНКЦИЯ ДЛЯ СМЕНЫ НОМЕРА (Hears '🔄 Изменить номер') ---
const handleChangePhone = (User) => async (ctx) => {
    const user = await User.findOne({ telegramId: ctx.from.id });
    
    // Сбрасываем текущий номер телефона в базе
    user.phone = null; 
    
    // Сразу переводим в шаг ожидания ввода
    user.currentStep = 'awaiting_new_phone'; 
    
    await user.save();
    
    // Запрашиваем ввод номера, убирая клавиатуру главного меню
    return ctx.reply('✍️ Введите номер телефона в международном формате (например, +79123456789):', Markup.removeKeyboard());
};

// --- ФУНКЦИЯ ДЛЯ РЕГИСТРАЦИИ ВСЕХ ОБРАБОТЧИКОВ АВТОРИЗАЦИИ ---
const registerAuthHandlers = (bot, User, showMainMenu) => {
    
    // 1. Обработчик /start
    bot.start(async (ctx) => {
        let user = await User.findOne({ telegramId: ctx.from.id });

        if (!user) {
            user = await User.create({ telegramId: ctx.from.id });
        } 
        
        // Если телефон отсутствует, запрашиваем его.
        if (!user.phone) {
            await ctx.reply('Привет! 👋');
            return requestPhone(ctx); 
        }
        
        // Если авторизован
        await ctx.reply(`С возвращением, ${ctx.from.first_name}!`);
        return showMainMenu(ctx);
    });

    // 2. Обработчик контакта (единый для start и смены номера)
    bot.on('contact', handleContact(User, showMainMenu));

    // 3. Обработчик смены номера (кнопка в главном меню)
    bot.hears('🔄 Изменить номер', handleChangePhone(User));
};

module.exports = {
    registerAuthHandlers,
    handleContact,
    handleChangePhone
};