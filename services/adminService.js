const Order = require('../models/Order');
const User = require('../models/User');
// Импортируем ваш клиент WhatsApp напрямую
const { sendTextMessage } = require('../whatsappClient'); 

// --- УНИВЕРСАЛЬНАЯ ФУНКЦИЯ УВЕДОМЛЕНИЯ ---
async function notifyClient(userId, message, providers = {}) {
    const user = await User.findById(userId);
    if (!user) return;

    // 1. Отправка в Telegram (если есть bot в провайдерах и ID у юзера)
    if (user.telegramId && providers.bot) {
        try {
            await providers.bot.telegram.sendMessage(
                user.telegramId, 
                message, 
                { parse_mode: 'Markdown' }
            );
        } catch (e) { 
            console.error(`TG Notify Error (User ${userId}):`, e.message); 
        }
    }

    // 2. Отправка в WhatsApp (если есть ID у юзера)
    // Мы берем функцию sendTextMessage напрямую из импорта, providers не нужен
    if (user.whatsappId) {
        try {
            // WhatsApp не поддерживает 'Markdown' в понимании Telegram,
            // но поддерживает *жирный* и _курсив_, так что текст совместим.
            await sendTextMessage(user.whatsappId, message);
        } catch (e) { 
            console.error(`WA Notify Error (User ${userId}):`, e.message); 
        }
    }
}

module.exports = {
    // Найти последний заказ по телефону
    async findLastOrder(phone) {
        return await Order.findOne({ clientPhone: phone }).sort({ timestamp: -1 });
    },

    // Установка трек-номера
    async setTracking(orderId, data, providers) {
        const { number, url } = data; // Обратите внимание: в admin.js вы передаете { number, url }

        const order = await Order.findByIdAndUpdate(
            orderId,
            { 
                trackingNumber: number, 
                trackingUrl: url || '', 
                status: 'enviado',
                updatedAt: Date.now()
            }, 
            { new: true }
        );

        if (!order) throw new Error('Order not found');

        let msg = `📦 *Ваша посылка отправлена!*\n\n`;
        msg += `🔢 Трек-номер: *${number}*\n`;
        if (url) {
            msg += `🌐 Отследить: ${url}`;
        }

        // Уведомляем клиента
        await notifyClient(order.userId, msg, providers);
        return order;
    },

    // Смена статуса
    async updateStatus(orderId, Newstatus, providers) {
        console.log('DEBUG: Смена статуса заказа', orderId, `на ${Newstatus}`);

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
            'en tramito': '⏳ В обработке',
            'enviado': '🚀 Отправлен',
            'nuevo': '📝 Создан (Черновик)'
        };

        const readableStatus = statusMap[Newstatus] || Newstatus;
        const msg = `🔔 Статус вашего заказа *#${orderId.toString().slice(-4)}* изменился на: \n*${readableStatus}*`;
        
        // Уведомляем клиента
        await notifyClient(order.userId, msg, providers);
        return order;
    }
};