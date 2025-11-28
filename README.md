# clients-inventory
parcel inventory bot
add form PC

текущая структура (Telegram-центричная):
.
├── index.js             <-- Точка входа Telegram
├── models/
│   ├── User.js          <-- Модели (используются обеими платформами)
│   ├── Product.js
│   └── ...
├── handlers/
│   ├── category.js      <-- Логика кнопок/меню Telegram
│   └── auth.js
└── ...

структура с WhatsApp

├── index.js             <-- 🟢 Запускает Telegraf (Telegram)
├── whatsapp.js          <-- 🟢 Запускает Express (WhatsApp Webhooks)
├── models/
│   └── User.js          <-- Общая модель. Добавить поле whatsappId.
├── handlers/
│   ├── category.js      <-- 🔴 Логика UI для Telegram (ctx.reply, ctx.editMessageText)
│   ├── whatsappUI.js    <-- 🟢 Логика UI для WhatsApp (sendListMessage, sendTextMessage)
│   └── auth.js
├── whatsappClient.js    <-- 🟢 Файл с функцией sendMessage к Meta API
└── ...