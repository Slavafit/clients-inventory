// services/googleSheets.js
const { google } = require('googleapis');
const fs = require('fs');

let sheetsClient = null;
let spreadsheetId = process.env.GOOGLE_SHEET_ID;

// Инициализация (вызывается один раз при запуске бота)
function initGoogleSheets() {
    if (process.env.USE_GOOGLE_SHEETS === 'true' && fs.existsSync(process.env.GOOGLE_SHEETS_KEYFILE)) {
        try {
            const auth = new google.auth.GoogleAuth({
                keyFile: process.env.GOOGLE_SHEETS_KEYFILE,
                scopes: ['https://www.googleapis.com/auth/spreadsheets'],
            });
            sheetsClient = google.sheets({ version: 'v4', auth });
            console.log('✅ Google Sheets API подключен');
        } catch (e) {
            console.error('❌ Ошибка инициализации Google Sheets:', e.message);
        }
    }
}

// Функция добавления заказа
async function appendOrderToSheet(order) {
    if (!sheetsClient || !spreadsheetId) return;

    try {
        const itemsString = order.items.map(i => `${i.product} (${i.quantity} шт) (${i.total}€)`).join(', ');
        const dateStr = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Madrid' }); // Или ваш часовой пояс

        const values = [
            [dateStr, order.clientPhone, itemsString, order.totalSum, order.status]
        ];

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Sheet1!A:E', // Указываем столбцы (например, A-E)
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });
        console.log(`📝 Заказ ${order._id} записан в таблицу.`);
    } catch (error) {
        console.error('❌ Ошибка записи в Google Sheets:', error.message);
    }
}

module.exports = { initGoogleSheets, appendOrderToSheet };