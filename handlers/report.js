const User = require('./models/User');

async function sendStatusUpdate(order, newStatus, tracking = '') {
    const user = await User.findById(order.userId);
    if (!user) return;

    let message = `📦 *Обновление статуса заказа!*\n\n`;
    message += `Статус: ${newStatus}\n`;
    if (tracking) message += `Трек-номер: *${tracking}*\n`;
    message += `\nСпасибо, что выбрали нас!`;

    // 1. Если это пользователь Telegram
    if (user.telegramId) {
        const { bot } = require('./index'); // Импорт вашего экземпляра бота
        try {
            await bot.telegram.sendMessage(user.telegramId, message, { parse_mode: 'Markdown' });
        } catch (e) { console.error('Ошибка отправки в TG:', e.message); }
    } 
    // 2. Если это пользователь WhatsApp
    else if (user.whatsappId) {
        const { sendTextMessage } = require('./whatsappClient');
        try {
            await sendTextMessage(user.whatsappId, message);
        } catch (e) { console.error('Ошибка отправки в WA:', e.message); }
    }
}
module.exports = { 
    sendStatusUpdate
};