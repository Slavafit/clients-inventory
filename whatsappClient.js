// whatsappClient.js
require('dotenv').config();
const axios = require('axios');

const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// URL для отправки сообщений в Meta Cloud API
const API_URL = `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`;

/**
 * Отправляет любое сообщение через Meta Cloud API.
 * @param {string} recipientId - Номер телефона получателя (WhatsApp ID).
 * @param {object} messageBody - Тело сообщения в формате Meta API.
 */
async function sendMessage(recipientId, messageBody) {
    if (!WHATSAPP_TOKEN) {
        console.error("WHATSAPP_TOKEN не установлен!");
        return;
    }

    try {
        const response = await axios.post(API_URL, {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: recipientId,
            ...messageBody,
        }, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        console.log(`[WhatsApp] Сообщение успешно отправлено ${recipientId}`);
        return response.data;
    } catch (error) {
        console.error(`[WhatsApp ERROR] Не удалось отправить сообщение ${recipientId}:`, error.response ? error.response.data : error.message);
    }
}

module.exports = {
    sendMessage,
    // Добавим вспомогательные функции для UI (шаблонное сообщение)
    sendListMessage: (recipientId, header, body, buttonText, sections) => sendMessage(recipientId, {
        type: "interactive",
        interactive: {
            type: "list",
            header: { type: "text", text: header },
            body: { type: "text", text: body },
            action: { button: buttonText, sections: sections }
        }
    }),
    sendTextMessage: (recipientId, text) => sendMessage(recipientId, {
        type: "text",
        text: { body: text }
    })
};