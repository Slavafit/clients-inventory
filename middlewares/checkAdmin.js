const checkAdmin = (User) => async (ctx, next) => {
    const telegramId = ctx.from.id;
    
    if (!telegramId) {
        return; // Невозможно определить пользователя
    }

    // 1. ПРОВЕРКА ПО TELEGRAM ID ИЗ .env (СУПЕРАДМИН)
    // Преобразуем process.env.ADMIN_TELEGRAM_ID в число для надежного сравнения
    const superAdminId = parseInt(process.env.ADMIN_TELEGRAM_ID, 10);
    
    // Если пользовательский ID соответствует ID из .env, он всегда админ
    if (superAdminId && telegramId === superAdminId) {
        console.log(`[AUTH] СуперАдмин ${telegramId} допущен.`);
        return next();
    }
    
    // 2. ПРОВЕРКА ПО РОЛИ В БАЗЕ ДАННЫХ
    const user = await User.findOne({ telegramId });

    if (user && user.role === 'admin') {
        // Пользователь — администратор, разрешаем доступ
        console.log(`[AUTH] Пользователь ${telegramId} допущен по роли "admin".`);
        return next();
    } else {
        // Блокируем доступ
        console.log(`[AUTH] Пользователь ${telegramId} заблокирован (роль: ${user ? user.role : 'нет записи'}).`);
        return ctx.reply('⛔ У вас нет прав администратора для выполнения этой команды.');
    }
};

module.exports = { checkAdmin };