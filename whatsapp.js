require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const fs = require('fs'); 

const User = require('./models/User');
const Product = require('./models/Product');
const Category = require('./models/Category');
const Order = require('./models/Order');

// Эти функции вы должны были создать отдельно, либо уберите этот импорт, если пишите их здесь
// Я предполагаю, что они у вас есть, как в Telegram боте (но адаптированные под WhatsApp)
const { showCategorySelection, showProductSelection } = require('./handlers/whatsappUI');
const adminService = require('./services/adminService');
const { sendTextMessage } = require('./whatsappClient');

// --- Подключение к MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message));

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// --- Google Sheets API ---
let sheetsClient = null;
if (process.env.USE_GOOGLE_SHEETS === 'true' && fs.existsSync(process.env.GOOGLE_SHEETS_KEYFILE)) {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SHEETS_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets connected');
}

// --- 1. WEBHOOK ВЕРИФИКАЦИЯ (GET) ---
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === WHATSAPP_VERIFY_TOKEN) {
            console.log("✅ Webhook верифицирован!");
            return res.status(200).send(challenge);
        } else {
            return res.sendStatus(403);
        }
    }
    return res.sendStatus(400);
});

// --- 2. ОБРАБОТКА ВХОДЯЩИХ СООБЩЕНИЙ (POST) ---
app.post('/webhook', async (req, res) => {
    const data = req.body;

    // Сразу отвечаем 200 OK, чтобы WhatsApp не слал повторы
    res.sendStatus(200);

    try {
        if (data.object === 'whatsapp_business_account') {
            const changes = data.entry?.[0]?.changes?.[0];
            const message = changes?.value?.messages?.[0];
            const contacts = changes?.value?.contacts?.[0];

            if (message && contacts) {
                const whatsappId = message.from; 
                const userName = contacts.profile.name;
                let userText = message.text?.body || ''; 
                let payload = ''; 

                // Обработка интерактивных сообщений (кнопки/списки)
                if (message.interactive) {
                    if (message.interactive.type === 'list_reply') {
                        payload = message.interactive.list_reply.id;
                    } else if (message.interactive.type === 'button_reply') {
                        payload = message.interactive.button_reply.id;
                    }
                    // Текст сообщения игнорируем, если нажата кнопка
                    userText = '';
                }

                // 2. Найти или создать пользователя
                // ⚠️ ВАЖНО: Убедитесь, что в модели User есть поля whatsappId и tempProductId
                let user = await User.findOne({ whatsappId });
                if (!user) {
                    const formattedPhone = '+' + whatsappId; 
                    user = await User.create({ 
                        whatsappId, 
                        name: userName, 
                        currentStep: 'idle',
                        phone: formattedPhone,
                        currentOrder: []
                    });
                }

                // 3. Главный маршрутизатор
                await handleWhatsAppMessage(user, whatsappId, userText, payload);
            }
        }
    } catch (error) {
        console.error('❌ Ошибка в Webhook:', error);
    }
});


/**
 * Центральный обработчик логики
 */
async function handleWhatsAppMessage(user, whatsappId, text, payload) {
    const currentStep = user.currentStep;
    const command = text ? text.toLowerCase().trim() : ''; // 🟢 Определение переменной command

    // --- A. ОБРАБОТКА НАЖАТИЯ КНОПОК (Payload) ---
    if (payload) {
        // Выбор категории
        if (payload.startsWith('cat_')) {
            const categoryId = payload.split('_').pop();
            // Проверка на валидность ID
            if (!mongoose.Types.ObjectId.isValid(categoryId)) return;

            const category = await Category.findById(categoryId);
            if (!category) {
                 return sendTextMessage(whatsappId, '⚠️ Ошибка: Категория не найдена.');
            }
            return showProductSelection(whatsappId, categoryId, category.name);
        }

        // Выбор товара
        if (payload.startsWith('prod_')) {
            const productId = payload.split('_').pop();
            // Проверка на валидность ID
            if (!mongoose.Types.ObjectId.isValid(productId)) return;

            const product = await Product.findById(productId);
            if (!product) {
                return sendTextMessage(whatsappId, '⚠️ Ошибка: Товар не найден.');
            }
            
            // 🔥 СОХРАНЯЕМ ID ТОВАРА В БАЗУ, чтобы не потерять на следующем шаге
            user.tempProductId = productId; 
            user.currentStep = 'awaiting_quantity';
            await user.save();
            
            return sendTextMessage(whatsappId, `Вы выбрали *${product.name}*. \n\n🔢 Введите количество (числом):`);
        }
        
        // Свой товар
        if (payload === 'add_custom_product') {
            user.currentStep = 'awaiting_custom_product';
            await user.save();
            return sendTextMessage(whatsappId, '✍️ Введите название товара (например, Свеча ароматическая):');
        }
    } 
    
    // --- B. ОБРАБОТКА ТЕКСТА (Text) ---
    else if (text) {
        // Админские команды (простая реализация через текст, так как нет слэш-команд)
        // ВАЖНО: Добавьте проверку user.role === 'admin' если нужно
        if (command === 'админ категория') {
             user.currentStep = 'awaiting_category_name';
             await user.save();
             return sendTextMessage(whatsappId, '📝 Введите название новой категории:');
        }

        switch (currentStep) {
            case 'idle':
                    const isAdmin = user.role === 'admin';

                // Поиск клиента по номеру (только для админов)
                if (isAdmin && command.startsWith('поиск ')) {
                    const searchPhone = text.replace('поиск ', '').trim();
                    const Order = require('./models/Order'); // Убедитесь, что модель импортирована
                    
                    const lastOrder = await Order.findOne({ clientPhone: searchPhone }).sort({ createdAt: -1 });
                    
                    if (!lastOrder) {
                        return sendTextMessage(whatsappId, `❌ Заказ для номера ${searchPhone} не найден.`);
                    }

                    user.tempAdminOrderId = lastOrder._id;
                    user.currentStep = 'admin_order_manage';
                    await user.save();

                    return sendTextMessage(whatsappId, 
                        `📄 *Заказ найден:*\n` +
                        `ID: ${lastOrder._id}\n` +
                        `Сумма: ${lastOrder.totalSum}€\n` +
                        `Статус: ${lastOrder.status}\n` +
                        `Трек: ${lastOrder.trackingNumber || 'не установлен'}\n\n` +
                        `*Команды:*\n` +
                        `1. Напишите *ТРЕК*, чтобы установить номер отслеживания.\n` +
                        `2. Напишите *ОТМЕНА*, чтобы выйти.`
                    );
                }
                // Общая обработка текста в режиме ожидания (аналог bot.hears)
                if (text.toLowerCase() === 'начать') {
                    // 🚨 Заменяем startNewOrder Telegraf на showCategorySelection WhatsApp
                    user.currentOrder = [];
                    user.lastOrderId = null; // Сброс черновика
                    await user.save();
                    return showCategorySelection(whatsappId); 
                }
                if (command === 'сменить номер') {
                    user.currentStep = 'awaiting_new_phone';
                    await user.save();
                    return sendTextMessage(whatsappId, '📱 Введите новый номер телефона:');
                }
                return sendTextMessage(whatsappId, '👋 Привет! Напишите *Начать*, чтобы создать опись.');

            case 'awaiting_quantity':
                const qty = parseInt(command);
                if (isNaN(qty) || qty <= 0) {
                    return sendTextMessage(whatsappId, '⚠️ Пожалуйста, введите корректное число (количество).');
                }
                
                // 🔥 ВОССТАНАВЛИВАЕМ ТОВАР ИЗ БАЗЫ
                let productName = "Неизвестный товар";
                if (user.tempProductId) {
                    const productToOrder = await Product.findById(user.tempProductId);
                    if (productToOrder) productName = productToOrder.name;
                } else {
                    // Если вдруг tempProductId потерялся
                    user.currentStep = 'idle';
                    await user.save();
                    return sendTextMessage(whatsappId, '⚠️ Ошибка: Товар потерян. Начните заново.');
                }
                
                // Добавляем (quantity есть, total пока 0)
                user.currentOrder.push({ product: productName, quantity: qty, total: 0 }); 
                
                // Сбрасываем tempProductId
                user.tempProductId = null; 
                user.currentStep = 'awaiting_total';
                await user.save();
                
                return sendTextMessage(whatsappId, '💰 Введите *общую сумму* за эту позицию (например, 19.99):');
            
              
            case 'awaiting_total':
                const total = parseFloat(command.replace(',', '.'));
                if (isNaN(total) || total < 0) {
                    return sendTextMessage(whatsappId, '⚠️ Введите корректную сумму (число).');
                }
                
                // Обновляем сумму у последнего товара
                if (user.currentOrder.length > 0) {
                    user.currentOrder[user.currentOrder.length - 1].total = total;
                }
                
                user.currentStep = 'confirm_order';
                await user.save();
                
                const currentTotal = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
                
                // Здесь лучше отправить кнопки, если WhatsApp API позволяет, 
                // но пока используем текст для надежности
                return sendTextMessage(whatsappId, 
                    `✅ Добавлено! Итого: *${currentTotal.toFixed(2)}€*.\n\n` + 
                    '🔹 Напишите *ДОБАВИТЬ* — чтобы выбрать еще товар.\n' +
                    '🔹 Напишите *ЗАВЕРШИТЬ* — чтобы сохранить опись.'
                );
                // 🚨 НОВЫЙ CASE: Обработка команд после добавления позиции (Замена Inline-кнопок)
            case 'confirm_order':
                if (command === 'добавить') {
                    user.currentStep = 'idle'; // Временно в idle, чтобы сработал выбор категорий
                    await user.save();
                    return showCategorySelection(whatsappId); 
                    
                } else if (command === 'завершить') {
                    if (!user.currentOrder.length) {
                        return sendTextMessage(whatsappId, '⚠️ Опись пуста. Напишите *Начать*.');
                    }
                    
                    const totalSum = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
                    let currentPhone = user.phone;
                    let order;
                    
                    // Логика сохранения (Upsert)
                    if (user.lastOrderId) {
                        const existingOrder = await Order.findById(user.lastOrderId);
                        if (existingOrder && existingOrder.status === 'nuevo') {
                            order = await Order.findByIdAndUpdate(user.lastOrderId, {
                                clientPhone: currentPhone,
                                items: user.currentOrder,
                                totalSum: totalSum,
                            }, { new: true });
                        }
                    }

                    if (!order) {
                        order = await Order.create({
                            userId: user._id, // Убедитесь, что User модель имеет _id
                            clientPhone: currentPhone,
                            items: user.currentOrder,
                            totalSum: totalSum,
                            status: 'nuevo' 
                        });
                    }

                    user.currentOrder = [];
                    user.lastOrderId = order._id;
                    user.currentStep = 'awaiting_final_send'; 
                    await user.save();
                    
                    return sendTextMessage(whatsappId, 
                        `💾 Черновик (ID: ${order._id}) сохранен.\nИтого: ${totalSum.toFixed(2)}€\n\n` +
                        '🚀 Напишите *ОТПРАВИТЬ* для подтверждения.\n' +
                        '✏️ Напишите *РЕДАКТИРОВАТЬ* для изменения.'
                    );
                    
                } else {
                    return sendTextMessage(whatsappId, 'Введите *ДОБАВИТЬ* или *ЗАВЕРШИТЬ*.');
                }
            
                // 🚨 НОВЫЙ CASE: Ожидание команды на окончательную отправку
            case 'awaiting_final_send':
                if (command === 'отправить') {
                    const orderId = user.lastOrderId; 
                    const order = await Order.findById(orderId);
                    
                    if (!order || order.status !== 'nuevo') {
                        user.currentStep = 'idle';
                        await user.save();
                        return sendTextMessage(whatsappId, '⚠️ Заказ уже отправлен или не найден.');
                    }
                    
                    // Google Sheets
                    if (sheetsClient) {
                        const total = order.totalSum;
                        // Форматируем список товаров в строку
                        const itemsString = order.items.map(i => `${i.product} (${i.quantity}шт)`).join(', ');
                        
                        const values = [
                            [new Date().toLocaleString(), order.clientPhone, itemsString, total]
                        ];
                        
                        try {
                            await sheetsClient.spreadsheets.values.append({
                                spreadsheetId: process.env.GOOGLE_SHEET_ID,
                                range: 'Sheet1!A:D',
                                valueInputOption: 'USER_ENTERED',
                                requestBody: { values }
                            });
                        } catch (error) {
                            console.error('Ошибка Google Sheets:', error);
                        }
                    }
                    
                    order.status = 'enviado'; 
                    await order.save();
                    
                    user.lastOrderId = null;
                    user.currentStep = 'idle';
                    await user.save();
                    
                    return sendTextMessage(whatsappId, `🚀 Опись отправлена! Спасибо.`);
                    
                } else if (command === 'редактировать') {
                    // Возвращаем товары из заказа в корзину пользователя
                    const order = await Order.findById(user.lastOrderId);
                    if (order) {
                        user.currentOrder = order.items;
                        user.currentStep = 'confirm_order'; // Возвращаем на шаг выбора действий
                        await user.save();
                        return sendTextMessage(whatsappId, '✏️ Режим редактирования. Напишите *ДОБАВИТЬ* или *ЗАВЕРШИТЬ*.');
                    } else {
                        user.currentStep = 'idle';
                        await user.save();
                        return sendTextMessage(whatsappId, '⚠️ Ошибка черновика.');
                    }
                } else {
                    return sendTextMessage(whatsappId, 'Введите *ОТПРАВИТЬ* или *РЕДАКТИРОВАТЬ*.');
                }

            case 'awaiting_custom_product':
                user.currentOrder.push({ product: text, quantity: 0, total: 0 });
                user.currentStep = 'awaiting_quantity';
                // tempProductId здесь null, поэтому в awaiting_quantity нужно добавить проверку
                // но так как мы пушим product сразу как имя, в awaiting_quantity логика восстановления имени не сработает
                // ⚠️ УПРОЩЕНИЕ: Для кастомного товара мы сразу просим количество здесь
                user.currentStep = 'awaiting_quantity_custom'; // Создадим временный шаг, чтобы не ломать логику
                await user.save();
                return sendTextMessage(whatsappId, 'Введите количество:');
            
                // Специальный шаг для кастомного товара, чтобы не путаться с tempProductId
            case 'awaiting_quantity_custom':
                 const cQty = parseInt(command);
                 if (isNaN(cQty) || cQty <= 0) return sendTextMessage(whatsappId, 'Введите число.');
                 
                 // Обновляем последний элемент (это наш кастомный товар)
                 user.currentOrder[user.currentOrder.length - 1].quantity = cQty;
                 user.currentStep = 'awaiting_total';
                 await user.save();
                 return sendTextMessage(whatsappId, '💰 Введите общую сумму:');

            case 'awaiting_category_name':
                const newCategory = await Category.create({ name: text });
                user.currentStep = 'idle';
                await user.save();
                return sendTextMessage(whatsappId, `✅ Категория "${newCategory.name}" создана!`);
                
            case 'awaiting_new_phone':
                const cleanedText = text.replace(/[^0-9]/g, ''); 
                if (cleanedText.length < 9) {
                    return sendTextMessage(whatsappId, 'Слишком короткий номер.');
                }
                let formattedPhone = text.trim();
                if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;

                user.phone = formattedPhone;
                user.currentStep = 'idle';
                await user.save();
                return sendTextMessage(whatsappId, `Номер сохранён: ${formattedPhone}`);

            case 'admin_order_manage':
                if (command === 'трек') {
                    user.currentStep = 'admin_awaiting_track';
                    await user.save();
                    return sendTextMessage(whatsappId, '🔢 Введите трек-номер для этого заказа:');
                } else if (command === 'отмена') {
                    user.currentStep = 'idle';
                    user.tempAdminOrderId = null;
                    await user.save();
                    return sendTextMessage(whatsappId, 'Админ-режим закрыт.');
                }
                return sendTextMessage(whatsappId, 'Неизвестная команда. Введите *ТРЕК* или *ОТМЕНА*.');
                
            case 'admin_awaiting_track':
                user.tempTrackNumber = text.trim(); // Временно сохраняем номер
                user.currentStep = 'admin_awaiting_track_link'; 
                await user.save();
                return sendTextMessage(whatsappId, "🔗 Теперь введите ссылку на сервис отслеживания или напишите 'НЕТ':");


            case 'admin_awaiting_track_link':
                const linkInput = text.trim();
                const trackLink = linkInput.toLowerCase() === 'нет' ? '' : linkInput;

                // Проверка на http (опционально)
                if (trackLink && !trackLink.startsWith('http')) {
                    return sendTextMessage(whatsappId, '⚠️ Ссылка должна начинаться с http или https. Попробуйте снова или напишите "нет".');
                }

                try {
                    // Вызываем общий сервис
                    await adminService.setTracking(
                        user.tempAdminOrderId, 
                        { number: user.tempTrackNumber, url: trackLink }, 
                        { sendTextMessage } // Передаем функцию отправки для WA
                    );

                    // Сбрасываем состояние
                    user.currentStep = 'idle';
                    user.tempTrackNumber = null;
                    user.tempAdminOrderId = null;
                    await user.save();

                    return sendTextMessage(whatsappId, '✅ Данные сохранены. Клиент получил уведомление.');
                } catch (err) {
                    console.error(err);
                    user.currentStep = 'idle';
                    await user.save();
                    return sendTextMessage(whatsappId, '❌ Ошибка при сохранении. Попробуйте снова через поиск.');
                }
                default:
                // Неизвестный шаг, можно сбросить состояние
                return sendTextMessage(whatsappId, 'Пожалуйста, следуйте инструкциям. Если что-то пошло не так, напишите "Начать".');
        }
    }
}

async function notifyClientStatusUpdate(order) {
    const User = require('./models/User');
    const client = await User.findById(order.userId);
    
    if (!client) return;

    const message = `📦 *Ваш заказ обновлен!*\n\n` +
                    `Новый статус: *${order.status === 'enviado' ? 'Отправлено' : order.status}*\n` +
                    (order.trackingNumber ? `Трек-номер: *${order.trackingNumber}*` : '');

    // Если у клиента есть whatsappId, отправляем в WhatsApp
    if (client.whatsappId) {
        await sendTextMessage(client.whatsappId, message);
    } 
    // Если клиент из Telegram, отправляем через бота Telegram
    else if (client.telegramId) {
        // Здесь потребуется доступ к объекту bot из index.js или отдельный экспорт
        // bot.telegram.sendMessage(client.telegramId, message, { parse_mode: 'Markdown' });
    }
}

app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Webhook Server running on port ${PORT}`);
});