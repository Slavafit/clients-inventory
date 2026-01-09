// whatsappClient.js
require('dotenv').config();
const axios = require('axios');

const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const API_URL = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`;

async function sendMessage(recipientId, messageBody) {
    if (!WHATSAPP_TOKEN) return console.error("WHATSAPP_TOKEN отсутствует!");
    try {
        await axios.post(API_URL, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: recipientId,
            ...messageBody,
        }, { headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' } });
    } catch (error) {
        console.error(`Ошибка WA: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
    }
}

module.exports = {
    sendMessage,
    
    // Отправка простого текста
    sendTextMessage: (recipientId, text) => sendMessage(recipientId, {
        type: "text",
        text: { body: text }
    }),

    // Отправка списка (для категорий/товаров)
    sendListMessage: (recipientId, header, body, buttonText, sections) => sendMessage(recipientId, {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: header },
            body: { type: "text", text: body },
            action: { button: buttonText, sections: sections }
        }
    }),

    // 🔥 НОВАЯ ФУНКЦИЯ: Кнопки (Reply Buttons) - максимум 3 кнопки
    sendReplyButtons: (recipientId, body, buttons) => {
        // buttons = [{ id: 'yes', title: 'Да' }, { id: 'no', title: 'Нет' }]
        const rows = buttons.map(b => ({
            type: "reply",
            reply: { id: b.id, title: b.title }
        }));

        return sendMessage(recipientId, {
            type: "interactive",
            interactive: {
                type: "button",
                body: { type: "text", text: body },
                action: { buttons: rows }
            }
        });
    }
};