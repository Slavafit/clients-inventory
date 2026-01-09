// handlers/whatsappUser.js
const mongoose = require('mongoose');
const { showMainMenu, showCategorySelection, showProductSelection, showOrderPreview } = require('../whatsappUI');
const { sendTextMessage, sendReplyButtons } = require('../whatsappClient');

// Импортируем ВАШИ существующие сервисы (DRY - Don't Repeat Yourself)
const googleSheetsService = require('../services/googleSheets'); 

module.exports = async function handleWhatsAppUser(message, user, { User, Order, Product, Category }) {
    const whatsappId = user.whatsappId;
    
    // Определяем тип сообщения (текст или интерактивный ответ)
    let type = message.type;
    let payload = null; // ID нажатой кнопки
    let textBody = null; // Текст сообщения

    if (type === 'text') {
        textBody = message.text.body;
    } else if (type === 'interactive') {
        const interactive = message.interactive;
        if (interactive.type === 'list_reply') {
            payload = interactive.list_reply.id;
            textBody = interactive.list_reply.title;
        } else if (interactive.type === 'button_reply') {
            payload = interactive.button_reply.id;
            textBody = interactive.button_reply.title;
        }
    }

    // --- ГЛОБАЛЬНЫЕ КОМАНДЫ ---
    if (textBody && (textBody.toLowerCase() === 'menu' || textBody.toLowerCase() === 'меню')) {
        user.currentStep = 'idle';
        await user.save();
        return showMainMenu(whatsappId);
    }
    
    if (payload === 'cancel_order') {
        user.currentOrder = [];
        user.currentStep = 'idle';
        await user.save();
        return sendTextMessage(whatsappId, "❌ Заказ отменен. Пишите 'Меню' для старта.");
    }

    // --- ОБРАБОТКА ШАГОВ (State Machine) ---
    switch (user.currentStep) {
        
        case 'idle':
            // Обработка главного меню
            if (payload === 'menu_create_order') {
                user.currentOrder = [];
                await user.save();
                return showCategorySelection(whatsappId);
            }
            if (payload === 'menu_my_orders') {
                // Логика просмотра заказов
                const orders = await Order.find({ userId: user._id }).sort({ createdAt: -1 }).limit(5);
                if (!orders.length) return sendTextMessage(whatsappId, "У вас нет заказов.");
                let msg = "🧾 *Ваши заказы:*\n";
                orders.forEach(o => msg += `🔹 ${o.createdAt.toLocaleDateString()} - ${o.status} (${o.totalSum}€)\n`);
                return sendTextMessage(whatsappId, msg);
            }
            if (payload === 'menu_support') {
                user.currentStep = 'awaiting_support';
                await user.save();
                return sendTextMessage(whatsappId, "✍️ Напишите ваш вопрос, и я передам его оператору:");
            }
            
            // Если просто текст
            return showMainMenu(whatsappId);

        // --- ЛОГИКА СОЗДАНИЯ ЗАКАЗА ---
        
        // 1. Выбор категории или товара
        case 'idle': // (дубль кейса не нужен, логика выбора категорий происходит "stateless" через ID кнопок)
             break; 
    }

    // Обработка нажатий КНОПОК (Вне зависимости от step, если прилетел payload)
    if (payload) {
        if (payload.startsWith('cat_')) {
            const catId = payload.split('_')[1];
            return showProductSelection(whatsappId, catId);
        }

        if (payload === 'add_custom_product') {
            user.currentStep = 'awaiting_custom_name';
            await user.save();
            return sendTextMessage(whatsappId, "✍️ Введите название товара:");
        }

        if (payload.startsWith('prod_')) {
            const prodId = payload.split('_')[1];
            const product = await Product.findById(prodId);
            
            // Сохраняем временные данные во временный объект в currentOrder (последний элемент)
            user.currentOrder.push({ 
                product: product.name, 
                quantity: 0, 
                total: 0 
            });
            user.currentStep = 'awaiting_quantity';
            await user.save();
            return sendTextMessage(whatsappId, `Введите количество для "${product.name}":`);
        }

        if (payload === 'add_more') {
            return showCategorySelection(whatsappId);
        }

        if (payload === 'send_order') {
            // ФИНАЛИЗАЦИЯ ЗАКАЗА
            const total = user.currentOrder.reduce((acc, item) => acc + item.total, 0);
            
            const newOrder = await Order.create({
                userId: user._id,
                clientPhone: user.phone || whatsappId, // WhatsApp ID это и есть телефон
                items: user.currentOrder,
                totalSum: total,
                status: 'nuevo' // Сразу создаем как черновик/новый
            });

            // 🔥 Используем ваш сервис для записи в Google Sheets
            await googleSheetsService.appendOrderToSheet(newOrder);

            // Сброс
            user.currentOrder = [];
            user.currentStep = 'idle';
            await user.save();

            await sendTextMessage(whatsappId, `✅ Заказ #${newOrder._id.toString().slice(-4)} оформлен!`);
            return showMainMenu(whatsappId);
        }
    }

    // --- ОБРАБОТКА ТЕКСТОВОГО ВВОДА ---
    if (type === 'text') {
        
        if (user.currentStep === 'awaiting_custom_name') {
            user.currentOrder.push({ product: textBody, quantity: 0, total: 0 });
            user.currentStep = 'awaiting_quantity';
            await user.save();
            return sendTextMessage(whatsappId, "Введите количество:");
        }

        if (user.currentStep === 'awaiting_quantity') {
            const qty = parseInt(textBody);
            if (isNaN(qty)) return sendTextMessage(whatsappId, "Пожалуйста, введите число.");
            
            // Обновляем последний товар
            const lastIdx = user.currentOrder.length - 1;
            user.currentOrder[lastIdx].quantity = qty;
            
            user.currentStep = 'awaiting_price';
            await user.save();
            return sendTextMessage(whatsappId, "Введите *общую сумму* за эту позицию (например: 15.50):");
        }

        if (user.currentStep === 'awaiting_price') {
            let price = parseFloat(textBody.replace(',', '.'));
            if (isNaN(price)) return sendTextMessage(whatsappId, "Введите корректную сумму.");

            const lastIdx = user.currentOrder.length - 1;
            user.currentOrder[lastIdx].total = price;
            
            user.currentStep = 'idle'; // Временно сбрасываем, но показываем превью
            await user.save();
            return showOrderPreview(whatsappId, user);
        }

        if (user.currentStep === 'awaiting_support') {
            // Тут можно отправить сообщение админу в Telegram
            // const { bot } = require('../index'); // Если доступен бот
            // bot.telegram.sendMessage(process.env.ADMIN_ID, `WA Support: ${textBody}`);
            
            await sendTextMessage(whatsappId, "Сообщение отправлено оператору!");
            user.currentStep = 'idle';
            await user.save();
            return showMainMenu(whatsappId);
        }
    }
};