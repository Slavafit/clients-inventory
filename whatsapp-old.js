require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const fs = require('fs');
// 🚨 Импорт моделей и UI-функций
const User = require('./models/User');
const Product = require('./models/Product');
const Order = require('./models/Order');
const { showCategorySelection, showProductSelection } = require('./handlers/whatsappUI');
const { sendTextMessage } = require('./whatsappClient');

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// --- Подключение к MongoDB ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message));

// --- Google Sheets API ---
let sheetsClient = null;
if (process.env.USE_GOOGLE_SHEETS === 'true' && fs.existsSync(process.env.GOOGLE_SHEETS_KEYFILE)) {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SHEETS_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('✅ Google Sheets connected');

  // Проверим наличие заголовков и создадим, если их нет
  (async () => {
    try {
      const sheetId = process.env.GOOGLE_SHEET_ID;
      const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: sheetId,
        range: 'Sheet1!A1:D1',
      });
      if (!res.data.values || res.data.values.length === 0) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: sheetId,
          range: 'Sheet1!A1:D1',
          valueInputOption: 'RAW',
          requestBody: {
            values: [['Дата', 'Телефон', 'Опись (товары)', 'Сумма']]
          }
        });
        console.log('✅ Заголовки добавлены');
      }
    } catch (err) {
      console.error('⚠️ Не удалось проверить/создать заголовки:', err.message);
    }
  })();
} else {
  console.log('⚠️ Google Sheets disabled or missing keyfile');
}

// --- 1. WEBHOOK ВЕРИФИКАЦИЯ (GET) ---
// Необходим для настройки в Meta Dashboard
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

    if (data.object === 'whatsapp_business_account') {
        // Проверяем, что это сообщение, а не статус или другая нотификация
        const changes = data.entry?.[0]?.changes?.[0];
        const message = changes?.value?.messages?.[0];
        const contacts = changes?.value?.contacts?.[0];

        if (message && contacts) {
            const whatsappId = message.from; // Номер телефона отправителя (ваш ID)
            const userName = contacts.profile.name;
            let userText = message.text?.body || ''; // Текстовое сообщение
            let payload = ''; // Данные с кнопки/списка

            // 1. Извлечение payload, если это интерактивное сообщение
            if (message.interactive) {
                if (message.interactive.type === 'list_reply') {
                    payload = message.interactive.list_reply.id;
                }
                // Для WhatsApp все интерактивные ответы обрабатываются как payload, 
                // а не как текст, поэтому обнуляем userText
                userText = '';
            }

            // 2. Найти или создать пользователя (ВАЖНО: Использовать whatsappId)
            let user = await User.findOne({ whatsappId });
            if (!user) {
                const formattedPhone = '+' + whatsappId;
                user = await User.create({ 
                    whatsappId,
                    name: userName,
                    currentStep: 'idle',
                    phone: formattedPhone
                });
            }

            // 3. Главный маршрутизатор (замена switch в Telegraf)
            await handleWhatsAppMessage(user, whatsappId, userText, payload);
        }
    }
    res.sendStatus(200); // Обязательно ответить 200, иначе Meta будет повторять запрос
});


/**
 * Центральный обработчик логики. Заменяет switch в bot.on('text') и bot.action.
 */
async function handleWhatsAppMessage(user, whatsappId, text, payload) {
    
    const currentStep = user.currentStep;
    
    // Нормализация текста для команд
    const command = text ? text.trim().toLowerCase() : '';
    
    // --- ОБРАБОТКА НАЖАТИЯ КНОПОК/СПИСКОВ (Payload) ---
    if (payload) {
        // 🚨 Начало новой описи (выбор категории)
        if (payload.startsWith('cat_')) {
            const categoryId = payload.split('_').pop();
            // На этом этапе вам нужно вызвать функцию для показа товаров
            const category = await Category.findById(categoryId);

            // Переходим к показу товаров
            return showProductSelection(whatsappId, categoryId, category.name);
        }

        // 🚨 Выбор товара
        if (payload.startsWith('prod_')) {
            const productId = payload.split('_').pop();
            const product = await Product.findById(productId);
            
            if (!product) {
                return sendTextMessage(whatsappId, '⚠️ Ошибка: Товар не найден. Пожалуйста, начните сначала.');
            }
            
            // 1. Сохраняем ID товара для следующего шага
            user.tempProductId = productId; 
            user.currentStep = 'awaiting_quantity';
            await user.save();
            
            return sendTextMessage(whatsappId, `Вы выбрали *${product.name}*. Теперь введите ТОЛЬКО ЧИСЛО, обозначающее количество (в штуках):`);
        }
        // 🚨 Добавление своего товара
        if (payload === 'add_custom_product') {
            user.currentStep = 'awaiting_custom_product';
            await user.save();
            return sendTextMessage(whatsappId, '✍️ Введите название товара (например, Свеча ароматическая):');
        }

        // ... (Добавьте обработку других payload, например, 'add_more', 'finish_order')

    } 
    // --- ОБРАБОТКА ТЕКСТОВОГО ВВОДА (Text) ---
    else if (text) {
        switch (currentStep) {
            case 'idle':
                // Общая обработка текста в режиме ожидания (аналог bot.hears)
                if (text.toLowerCase() === 'начать') {
                    // 🚨 Заменяем startNewOrder Telegraf на showCategorySelection WhatsApp
                    user.currentOrder = [];
                    await user.save();
                    return showCategorySelection(whatsappId); 
                }
                if (text.toLowerCase() === 'помощь') {
                    // 🚨 Здесь можно отправить INSTRUCTIONS_TEXT через sendTextMessage
                    // (Предполагая, что вы импортировали константу INSTRUCTIONS_TEXT)
                    return sendTextMessage(whatsappId, '📋 ИНСТРУКЦИЯ...');
                }
                return sendTextMessage(whatsappId, '👋 Привет! Напишите "Начать", чтобы создать опись, или "Помощь" для инструкции.');

            case 'awaiting_quantity':
                // 1. Проверяем количество
                const qty = parseInt(text.trim());
                if (isNaN(qty) || qty <= 0) {
                    return sendTextMessage(whatsappId, '⚠️ Некорректное количество. Введите только положительное число.');
                }
                
                // 2. 🚨 Находим название товара по сохраненному ID
                const productToOrder = await Product.findById(user.tempProductId);
                // Имя товара берется из БД. Если не найдено, используем заглушку.
                const productName = productToOrder ? productToOrder.name : "Неизвестный товар";
                
                // 3. Добавляем в текущий заказ
                user.currentOrder.push({ product: productName, quantity: qty, total: 0 }); 
                
                // 4. Очищаем tempProductId и переходим к сумме
                user.tempProductId = null; // ОЧЕНЬ ВАЖНО ОЧИСТИТЬ!
                user.currentStep = 'awaiting_total';
                await user.save();
                
                return sendTextMessage(whatsappId, '💰 Теперь введите *общую сумму* за эту позицию (например, 19.99):');
            
            case 'awaiting_custom_product':
                // Логика добавления своего товара (скопирована из index.js)
                user.currentOrder.push({ product: text, quantity: 0, total: 0 });
                user.currentStep = 'awaiting_quantity';
                await user.save();
                return sendTextMessage(whatsappId, 'Введите количество:');
                // Пользователь ввел текст в неактивном состоянии. Предложите начать.
                if (text.toLowerCase() === 'начать') {
                    return showCategorySelection(whatsappId);
                }
                return sendTextMessage(whatsappId, '👋 Привет! Напишите "Начать", чтобы создать опись, или "Помощь" для инструкции.');
                         
            case 'awaiting_total':
                // 1. Обработка суммы
                const total = parseFloat(command.replace(',', '.'));
                if (isNaN(total) || total < 0) {
                    return sendTextMessage(whatsappId, '⚠️ Некорректная сумма. Введите только положительное число.');
                }
                
                // 2. Обновляем последний добавленный элемент
                user.currentOrder[user.currentOrder.length - 1].total = total;
                
                // 3. Переход к состоянию ожидания команды ("Добавить" или "Завершить")
                user.currentStep = 'confirm_order';
                await user.save();
                
                const currentTotal = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
                
                return sendTextMessage(whatsappId, 
                    `✅ Товар добавлен! Текущая сумма описи: *${currentTotal.toFixed(2)}€*.\n\n` + 
                    'Что дальше? Напишите *ДОБАВИТЬ* чтобы продолжить, или *ЗАВЕРШИТЬ* чтобы сохранить черновик и отправить.'
                );
            // 🚨 НОВЫЙ CASE: Обработка команд после добавления позиции (Замена Inline-кнопок)
            case 'confirm_order':
                if (command === 'добавить') {
                    // 1. Логика "Добавить ещё товар" (аналог bot.action('add_more'))
                    user.currentStep = 'idle'; // Сброс для корректного перехода
                    await user.save();
                    
                    return showCategorySelection(whatsappId); // Начать выбор новой категории/товара
                    
                } else if (command === 'завершить') {
                    // 2. Логика "Сохранить черновик" (аналог bot.action('send_order'))
                    
                    if (!user || !user.currentOrder.length) {
                        user.currentStep = 'idle';
                        await user.save();
                        return sendTextMessage(whatsappId, 'Ошибка: Опись пуста.');
                    }
                    
                    const totalSum = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
                    let currentPhone = user.phone;
                    let order;
                    
                    // --- ЛОГИКА СОХРАНЕНИЯ/ОБНОВЛЕНИЯ ЧЕРНОВИКА (КОПИРОВАНИЕ ИЗ index.js) ---
                    
                    // Поиск и обновление существующего черновика
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

                    // Создание нового черновика
                    if (!order) {
                        order = await Order.create({
                            userId: user._id,
                            clientPhone: currentPhone,
                            items: user.currentOrder,
                            totalSum: totalSum,
                            status: 'nuevo' 
                        });
                    }

                    // Очистка временной корзины
                    user.currentOrder = [];
                    user.currentStep = 'awaiting_final_send'; // 🚨 НОВЫЙ ШАГ
                    user.lastOrderId = order._id;
                    await user.save();
                    
                    return sendTextMessage(whatsappId, 
                        `✅ Опись сохранена как *Черновик* (ID: ${order._id}). Итого: ${totalSum.toFixed(2)}€\n\n` +
                        'Что дальше? Напишите *ОТПРАВИТЬ*, чтобы окончательно зафиксировать заказ, или *РЕДАКТИРОВАТЬ*, чтобы начать с начала.'
                    );
                    
                } else {
                    return sendTextMessage(whatsappId, '🤔 Введите *ДОБАВИТЬ* или *ЗАВЕРШИТЬ*.');
                }
            
            // 🚨 НОВЫЙ CASE: Ожидание команды на окончательную отправку
            case 'awaiting_final_send':
                if (command === 'отправить') {
                    // 3. Логика "Окончательно отправить" (аналог bot.action('final_send_'))
                    const orderId = user.lastOrderId; // Берем ID из сохраненного поля
                    const order = await Order.findById(orderId);
                    
                    if (!order || order.status !== 'nuevo') {
                        user.currentStep = 'idle';
                        await user.save();
                        return sendTextMessage(whatsappId, '⚠️ Ошибка: Заказ не найден или уже отправлен.');
                    }
                    
                    // --- ЛОГИКА ОТПРАВКИ В GOOGLE SHEETS (КОПИРОВАНИЕ ИЗ index.js) ---
                        if (sheetsClient) {
                            const total = order.totalSum;
                            const values = [
                                [new Date().toLocaleString(), order.clientPhone, JSON.stringify(order.items), total]
                            ];
                            
                            try {
                                await sheetsClient.spreadsheets.values.append({
                                    spreadsheetId: process.env.GOOGLE_SHEET_ID,
                                    range: 'Sheet1!A:D',
                                    valueInputOption: 'USER_ENTERED',
                                    requestBody: { values }
                                });
                            } catch (error) {
                                console.error('Ошибка записи в Google Sheets:', error);
                                // Продолжаем, даже если Google Sheets не сработал
                            }
                        }
                    // 1. Меняем статус на "отправлен"
                    order.status = 'enviado'; 
                    await order.save();
                    
                    // 2. Сброс состояния
                    user.lastOrderId = null;
                    user.currentStep = 'idle';
                    await user.save();
                    
                    return sendTextMessage(whatsappId, `🚀 Опись ID ${orderId} *окончательно отправлена*!`);
                    
                } else if (command === 'редактировать') {
                    // В WhatsApp проще начать с начала
                    user.currentStep = 'idle';
                    user.lastOrderId = null; // Очищаем ссылку на черновик
                    await user.save();
                    return sendTextMessage(whatsappId, '❌ Редактирование отменено. Начните новую опись командой "Начать".');
                } else {
                    return sendTextMessage(whatsappId, '🤔 Введите *ОТПРАВИТЬ* или *РЕДАКТИРОВАТЬ*.');
                }

            default:
                // Неизвестный шаг, можно сбросить состояние
                return sendTextMessage(whatsappId, 'Пожалуйста, следуйте инструкциям. Если что-то пошло не так, напишите "Начать".');
        }
    }
}


app.listen(PORT, () => {
    console.log(`🚀 WhatsApp Webhook Server запущен на порту ${PORT}`);
});