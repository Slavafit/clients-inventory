const checkAdmin = (User) => async (ctx, next) => {
    const telegramId = ctx.from.id;
    
    if (!telegramId) {
        return; // Невозможно определить пользователя
    }

    const user = await User.findOne({ telegramId });

    if (user && user.role === 'admin') {
        // Пользователь — администратор, разрешаем доступ
        return next();
    } else {
        // Блокируем доступ
        return ctx.reply('⛔ У вас нет прав администратора для выполнения этой команды.');
    }
};

module.exports = { checkAdmin };