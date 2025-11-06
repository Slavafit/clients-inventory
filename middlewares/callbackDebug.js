const callbackDebug = () => async (ctx, next) => {
    // Проверяем, что это callback query (нажатие inline-кнопки)
    if (ctx.callbackQuery && ctx.callbackQuery.data) {
        let originalData = ctx.callbackQuery.data;
        
        // Очищаем callback_data от потенциальных невидимых символов и обрезаем пробелы
        ctx.callbackQuery.data = originalData.trim().replace(/[^\x20-\x7E]/g, '');
        
        // 🟢 Логирование очищенных данных
        if (originalData !== ctx.callbackQuery.data) {
            console.log(`[MIDDLEWARE-CLEANUP] Data changed from: ${originalData} to: ${ctx.callbackQuery.data}`);
        }
        console.log(`[MIDDLEWARE-DEBUG] Final callback_data: ${ctx.callbackQuery.data}`);
    }
    
    return next();
};

module.exports = { callbackDebug };