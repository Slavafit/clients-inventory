// whatsapp.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');

// Модели
const User = require('./models/User');
const Product = require('./models/Product');
const Category = require('./models/Category');
const Order = require('./models/Order');

// Сервисы
const googleSheetsService = require('./services/googleSheets');
const handleWhatsAppUser = require('./handlers/whatsappUser');

// --- Init ---
const app = express();
app.use(bodyParser.json());

// Запускаем подключение к Google Sheets
googleSheetsService.initGoogleSheets();

// Если запускаете whatsapp.js отдельно от index.js, раскомментируйте подключение к БД:
/*
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ WA: MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message));
*/

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// 1. Верификация Webhook (нужно для Meta)
app.get('/webhook', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
        res.status(200).send(req.query['hub.challenge']);
    } else {
        res.sendStatus(403);
    }
});

// 2. Получение сообщений
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object) {
        if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages) {
            const message = body.entry[0].changes[0].value.messages[0];
            const whatsappId = message.from; // Номер телефона (ID)

            // Находим или создаем пользователя
            let user = await User.findOne({ whatsappId });
            if (!user) {
                user = await User.create({ 
                    whatsappId, 
                    phone: '+' + whatsappId, // Обычно ID совпадает с телефоном
                    role: 'client' 
                });
            }

            // 🔥 Передаем управление в чистый хендлер
            await handleWhatsAppUser(message, user, { User, Order, Product, Category });
        }
        res.sendStatus(200);
    } else {
        res.sendStatus(404);
    }
});

const PORT = process.env.PORT_WA || 3000;
app.listen(PORT, () => console.log(`🚀 WhatsApp Webhook running on port ${PORT}`));