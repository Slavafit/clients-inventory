const Order = require('../models/Order');
const User = require('../models/User');

//функция оповещения
async function notifyClient(userId, message, providers = {}) {
    const user = await User.findById(userId);
    if (!user) return;

    if (user.telegramId && providers.bot) {
        try {
            await providers.bot.telegram.sendMessage(
                user.telegramId, 
                message, 
                { parse_mode: 'Markdown' 
            });
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

    async setTracking(orderId, data, providers) {
          const { trackNumber, url } = data;

        const order = await Order.findByIdAndUpdate(
                        orderId,
            { 
                trackingNumber: trackNumber, 
                trackingUrl: url || '', 
                status: 'enviado',
                updatedAt: Date.now()
            }, 
            { new: true }
        );
        let msg = `📦 *Ваша посылка отправлена!*\n\n`;
        msg += `🔢 Трек-номер: *${trackNumber}*\n`;
        if (url) {
            msg += `🌐 Отследить можно здесь: ${url}`;
        }
        await notifyClient(order.userId, msg, providers);
        return order;
    },

    // 🟢 Общая функция смены статуса
    async updateStatus(orderId, Newstatus, providers) {
                      console.log('DEBUG: функция смены статуса',orderId,` ${Newstatus}`);

        const order = await Order.findByIdAndUpdate(
            orderId, 
            { status: Newstatus, updatedAt: Date.now() }, 
            { new: true }
        );

          if (!order) {
        throw new Error(`Order not found: ${orderId}`);
        }
        
        const statusMap = {
            'entregado': '✅ Доставлен',
            'cancelado': '❌ Отменен',
            'en tramito': '⏳ В обработке'
        };

        const msg = `🔔 Статус вашего заказа #${orderId.toString().slice(-6)} изменился на: *${statusMap[Newstatus] || Newstatus}*`;
        await notifyClient(order.userId, msg, providers);
        return order;
    }
};