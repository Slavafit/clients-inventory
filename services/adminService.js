const Order = require('../models/Order');
const User = require('../models/User');

async function notifyClient(userId, message, providers) {
    const user = await User.findById(userId);
    if (!user) return;

    if (user.telegramId && providers.bot) {
        try {
            await providers.bot.telegram.sendMessage(user.telegramId, message, { parse_mode: 'Markdown' });
        } catch (e) { console.error('TG Notify Error:', e.message); }
    }

    if (user.whatsappId && providers.sendTextMessage) {
        try {
            await providers.sendTextMessage(user.whatsappId, message);
        } catch (e) { console.error('WA Notify Error:', e.message); }
    }
}

module.exports = {
    async findLastOrder(phone) {
        return await Order.findOne({ clientPhone: phone }).sort({ timestamp: -1 });
    },

    async setTracking(orderId, trackNumber, providers) {
        const order = await Order.findByIdAndUpdate(
            orderId, 
            { trackingNumber: trackNumber, status: 'enviado', updatedAt: Date.now() }, 
            { new: true }
        );
        const msg = `📦 *Ваш заказ отправлен!*\nТрек-номер: *${trackNumber}*`;
        await notifyClient(order.userId, msg, providers);
        return order;
    },

    // 🟢 ДОБАВЛЕНО: Общая функция смены статуса
    async updateStatus(orderId, newStatus, providers) {
        const order = await Order.findByIdAndUpdate(
            orderId, 
            { status: newStatus, updatedAt: Date.now() }, 
            { new: true }
        );
        
        const statusMap = {
            'entregado': '✅ Доставлен',
            'cancelado': '❌ Отменен',
            'en tramito': '⏳ В обработке'
        };

        const msg = `🔔 Статус вашего заказа #${orderId.toString().slice(-6)} изменился на: *${statusMap[newStatus] || newStatus}*`;
        await notifyClient(order.userId, msg, providers);
        return order;
    }
};