// admin.js
const adminService = require('../services/adminService');

bot.action(/set_status_(.+)_(.+)/, async (ctx) => {
    const [_, status, orderId] = ctx.match;
    
    // Вместо ручного обновления вызываем сервис
    // (нужно добавить функцию updateStatus в adminService.js по аналогии с setTracking)
    await adminService.updateStatus(orderId, status, { bot, sendTextMessage: null });

    ctx.reply(`✅ Статус заказа изменен на ${status}`);
});