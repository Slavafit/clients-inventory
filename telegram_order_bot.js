// telegram-mongo-shipments-bot.js
// Node.js Telegram bot using Telegraf, Mongoose (MongoDB Atlas) and Google Sheets
// Features:
// - Identification by phone (contact sharing or manual input)
// - Welcome and main menu (Create Shipment, My Shipments)
// - Create shipment: add multiple items (predefined or custom), quantity, item sum
// - Before sending, user sees final summary (including total sum) and confirms with one button
// - On confirm: shipment is saved to MongoDB (collection `shipments`) and exported to Google Sheets
// - Users see only their own shipments; can view contents of each shipment
// - All important areas are commented for clarity

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const fs = require('fs');
const { google } = require('googleapis');

// --------------------
// Configuration (.env variables)
// --------------------
// BOT_TOKEN - Telegram bot token (from @BotFather)
// MONGO_URI - MongoDB Atlas connection string (include credentials)
// USE_GOOGLE_SHEETS - true/false
// GOOGLE_SHEETS_KEYFILE - path to service account JSON key (e.g., ./service-account.json)
// GOOGLE_SHEET_ID - ID of the Google Sheet where orders will be appended
// PORT (optional) - for webhook setups (not required for polling)

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const USE_GOOGLE_SHEETS = (process.env.USE_GOOGLE_SHEETS || 'true').toLowerCase() === 'true';
const GOOGLE_SHEETS_KEYFILE = process.env.GOOGLE_SHEETS_KEYFILE || './service-account.json';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required in .env');
if (!MONGO_URI) throw new Error('MONGO_URI is required in .env');

// --------------------
// Initialize Google Sheets client (optional)
// --------------------
let sheetsClient = null;
async function initGoogleSheets() {
  if (!USE_GOOGLE_SHEETS) return;
  if (!fs.existsSync(GOOGLE_SHEETS_KEYFILE)) {
    console.warn('Google Sheets keyfile not found:', GOOGLE_SHEETS_KEYFILE);
    return;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SHEETS_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('Google Sheets client initialized');
}

async function appendRowToGoogleSheet(row) {
  if (!sheetsClient) throw new Error('Sheets client not initialized');
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'orders!A:Z', // expects a sheet named 'orders' (create it or adjust)
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [row] }
  });
}

// --------------------
// Mongoose models
// --------------------
// Connect to MongoDB Atlas
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => { console.error('MongoDB connection error', err); process.exit(1); });

const { Schema, model } = mongoose;

// User schema: stores basic user info and an optional in-progress shipment
const userSchema = new Schema({
  telegramId: { type: Number, required: true, unique: true },
  name: { type: String },
  phone: { type: String },
  createdAt: { type: Date, default: Date.now },
  // inProgressShipment keeps temporary state when user is creating a shipment
  inProgressShipment: {
    items: [{ name: String, quantity: Number, sum: Number }],
    step: String // helper to track where user is in the flow
  }
});
const User = model('User', userSchema);

// Shipment schema: final saved shipment (one shipment = one опись)
const shipmentSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  telegramId: { type: Number, required: true },
  userName: String,
  phone: String,
  items: [{ name: String, quantity: Number, sum: Number }],
  totalSum: Number,
  createdAt: { type: Date, default: Date.now }
});
const Shipment = model('Shipment', shipmentSchema);

// --------------------
// Bot initialization
// --------------------
const bot = new Telegraf(BOT_TOKEN);

// Predefined categories/products (you said it doesn't matter now; easy to change)
const PRODUCT_OPTIONS = ['Одежда', 'Продукты', 'Другое (ввести вручную)'];

// Helpers: present main menu
function mainMenu() {
  return Markup.keyboard([
    ['🧾 Создать опись для отправления', '📦 Мои отправления']
  ]).resize();
}

// Helpers: inline keyboard for adding item actions
function addItemKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ Добавить позицию', 'add_item')],
    [Markup.button.callback('✅ Отправить опись', 'send_shipment')],
    [Markup.button.callback('❌ Отмена', 'cancel_shipment')]
  ]);
}

// --------------------
// Conversation flow handlers
// --------------------

// /start command: greet and ask for phone if not known
bot.start(async (ctx) => {
  const tgId = ctx.from.id;
  let user = await User.findOne({ telegramId: tgId });
  if (!user) {
    // New user: create record without phone, ask for contact
    user = new User({ telegramId: tgId, name: `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim() });
    await user.save();
  }

  // If phone not known, ask to share contact or enter manually
  if (!user.phone) {
    await ctx.reply(`Привет, ${user.name || ctx.from.first_name || ''}!\nПожалуйста, отправь свой номер телефона или нажми кнопку ниже.`,
      Markup.keyboard([[Markup.button.contactRequest('📞 Поделиться номером')]]).oneTime().resize());
    return;
  }

  // Known user
  await ctx.reply(`Привет, ${user.name || ctx.from.first_name || ''}! Что вы хотите сделать?`, mainMenu());
});

// Handle contact share
bot.on('contact', async (ctx) => {
  const contact = ctx.message.contact;
  const tgId = ctx.from.id;
  if (!contact || !contact.phone_number) return ctx.reply('Контакт некорректен.');

  let user = await User.findOne({ telegramId: tgId });
  if (!user) user = new User({ telegramId: tgId });
  user.phone = contact.phone_number;
  user.name = user.name || `${ctx.from.first_name || ''} ${ctx.from.last_name || ''}`.trim();
  await user.save();

  await ctx.reply(`Номер сохранён: ${user.phone}`);
  await ctx.reply(`Привет, ${user.name}! Что вы хотите сделать?`, mainMenu());
});

// Handle plain text messages (phone manual input or generic commands)
bot.on('text', async (ctx) => {
  const tgId = ctx.from.id;
  const text = ctx.message.text.trim();

  const user = await User.findOne({ telegramId: tgId });
  if (!user) return ctx.reply('Нажмите /start чтобы начать.');

  // If phone missing, accept manual phone input
  if (!user.phone) {
    const phoneCandidate = text.replace(/\s+/g, '');
    if (/^\+?\d{7,15}$/.test(phoneCandidate)) {
      user.phone = phoneCandidate;
      await user.save();
      await ctx.reply(`Номер сохранён: ${user.phone}`);
      await ctx.reply('Что вы хотите сделать?', mainMenu());
      return;
    }
    return ctx.reply('Пожалуйста, отправьте корректный номер телефона (или нажмите кнопку для отправки контакта).');
  }

  // Main menu actions
  if (text === '🧾 Создать опись для отправления') {
    // Initialize inProgressShipment in user doc
    user.inProgressShipment = { items: [], step: 'choose_product' };
    await user.save();

    return ctx.reply('Выберите категорию/товар или выберите "Другое" для ручного ввода:',
      Markup.inlineKeyboard(PRODUCT_OPTIONS.map(p => Markup.button.callback(p, `prod_${p}`))));
  }

  if (text === '📦 Мои отправления') {
    // Fetch shipments for this user
    const shipments = await Shipment.find({ telegramId: tgId }).sort({ createdAt: -1 }).limit(10);
    if (!shipments.length) return ctx.reply('У вас ещё нет отправлений.', mainMenu());

    // Build list with buttons for each shipment to view details
    const lines = shipments.map((s, idx) => `${idx + 1}. ${s.createdAt.toLocaleString()} — ${s.items.length} позиций — ${s.totalSum}`);
    const buttons = shipments.map((s) => [Markup.button.callback(`📄 ${s.createdAt.toLocaleDateString()} — ${s.totalSum}`, `view_${s._id}`)]);
    await ctx.reply('📦 Ваши отправления:\n' + lines.join('\n'));
    return ctx.reply('Выберите отправление, чтобы увидеть опись:', Markup.inlineKeyboard(buttons));
  }

  // If user is in the flow adding items, handle steps based on inProgressShipment.step stored in DB
  if (user.inProgressShipment && user.inProgressShipment.step) {
    const step = user.inProgressShipment.step;

    if (step === 'waiting_custom_product') {
      // The text is the product name
      const name = text;
      user.inProgressShipment.currentItem = { name };
      user.inProgressShipment.step = 'waiting_quantity';
      await user.save();
      return ctx.reply('Введите количество (в штуках):');
    }

    if (step === 'waiting_quantity') {
      const qty = parseInt(text.replace(/[^0-9]/g, ''), 10);
      if (!qty || qty <= 0) return ctx.reply('Введите корректное целое количество > 0');
      user.inProgressShipment.currentItem.quantity = qty;
      user.inProgressShipment.step = 'waiting_sum';
      await user.save();
      return ctx.reply('Введите сумму для этой позиции (например: 199.99):');
    }

    if (step === 'waiting_sum') {
      const normalized = text.replace(',', '.');
      const sum = parseFloat(normalized);
      if (isNaN(sum) || sum < 0) return ctx.reply('Введите корректную сумму (число).');
      // finalize current item and push to items array
      const item = user.inProgressShipment.currentItem;
      item.sum = sum;
      if (!user.inProgressShipment.items) user.inProgressShipment.items = [];
      user.inProgressShipment.items.push(item);
      // clear currentItem
      delete user.inProgressShipment.currentItem;
      // set step back to choose_product to allow adding more items
      user.inProgressShipment.step = 'choose_product';
      await user.save();

      // Show current list and show options
      const itemsText = user.inProgressShipment.items.map((it, i) => `${i + 1}. ${it.name} — ${it.quantity} шт — ${it.sum}`).join('\n');
      await ctx.reply(`Текущие позиции:\n${itemsText}`, addItemKeyboard());
      return;
    }
  }

  // Default fallback
  return ctx.reply('Нажмите одну из кнопок меню или /start чтобы начать.', mainMenu());
});

// Handle inline callback queries
bot.on('callback_query', async (ctx) => {
  const tgId = ctx.from.id;
  const data = ctx.callbackQuery.data;
  const user = await User.findOne({ telegramId: tgId });
  if (!user) return ctx.answerCbQuery('Пожалуйста, нажмите /start');

  // Product option selected
  if (data.startsWith('prod_')) {
    const product = data.slice(5);
    if (product === 'Другое (ввести вручную)') {
      user.inProgressShipment.step = 'waiting_custom_product';
      await user.save();
      await ctx.answerCbQuery();
      return ctx.reply('Введите название товара вручную:');
    }
    // For a selected product category, we interpret it as an item name
    user.inProgressShipment.currentItem = { name: product };
    user.inProgressShipment.step = 'waiting_quantity';
    await user.save();
    await ctx.answerCbQuery(`Вы выбрали: ${product}`);
    return ctx.reply('Введите количество (в штуках):');
  }

  // Add item button pressed (from addItemKeyboard)
  if (data === 'add_item') {
    // go back to choose product
    user.inProgressShipment.step = 'choose_product';
    await user.save();
    await ctx.answerCbQuery();
    return ctx.reply('Выберите товар или "Другое" для ручного ввода:',
      Markup.inlineKeyboard(PRODUCT_OPTIONS.map(p => Markup.button.callback(p, `prod_${p}`))));
  }

  // Send shipment (confirm)
  if (data === 'send_shipment') {
    // Validate there is at least one item and compute total
    const items = (user.inProgressShipment && user.inProgressShipment.items) || [];
    if (!items.length) {
      await ctx.answerCbQuery('Нельзя отправить пустую опись. Добавьте хотя бы одну позицию.');
      return ctx.reply('Добавьте хотя бы одну позицию перед отправкой.', addItemKeyboard());
    }
    // Compute total
    const total = items.reduce((s, it) => s + (Number(it.sum) || 0), 0);

    // Show final summary and final confirmation buttons
    const itemsText = items.map((it, i) => `${i + 1}. ${it.name} — ${it.quantity} шт — ${it.sum}`).join('\n');
    await ctx.reply(`Проверьте опись:\n${itemsText}\n\nИтого: ${total}`,
      Markup.inlineKeyboard([[Markup.button.callback('✅ Подтвердить отправку', 'final_confirm')],[Markup.button.callback('❌ Отмена', 'cancel_shipment')]]));
    await ctx.answerCbQuery();
    return;
  }

  // Final confirmation: save shipment to MongoDB and Google Sheets
  if (data === 'final_confirm') {
    const items = (user.inProgressShipment && user.inProgressShipment.items) || [];
    if (!items.length) return ctx.answerCbQuery('Нет позиций для сохранения.');
    const total = items.reduce((s, it) => s + (Number(it.sum) || 0), 0);

    // Create shipment document
    const shipment = new Shipment({
      userId: user._id,
      telegramId: user.telegramId,
      userName: user.name,
      phone: user.phone,
      items,
      totalSum: total
    });
    await shipment.save();

    // Export to Google Sheets if enabled
    try {
      if (USE_GOOGLE_SHEETS && sheetsClient && GOOGLE_SHEET_ID) {
        // Build readable items string for sheet (or use JSON)
        const itemsStr = items.map(it => `${it.name} x${it.quantity} (${it.sum})`).join(' | ');
        const row = [new Date().toISOString(), user.phone || '', user.name || '', shipment._id.toString(), items.length, total, itemsStr];
        await appendRowToGoogleSheet(row);
      }
    } catch (err) {
      console.error('Error appending to Google Sheets:', err);
      // Not fatal — shipment already saved in MongoDB
    }

    // Clear inProgressShipment in user doc
    user.inProgressShipment = { items: [], step: null };
    await user.save();

    await ctx.answerCbQuery('Отправление сохранено');
    await ctx.reply('✅ Ваша опись отправлена и сохранена. Спасибо!', mainMenu());
    return;
  }

  // Cancel shipment
  if (data === 'cancel_shipment') {
    user.inProgressShipment = { items: [], step: null };
    await user.save();
    await ctx.answerCbQuery('Отмена');
    return ctx.reply('Операция отменена.', mainMenu());
  }

  // View specific shipment
  if (data.startsWith('view_')) {
    const id = data.slice(5);
    try {
      const shipment = await Shipment.findById(id);
      if (!shipment) return ctx.answerCbQuery('Отправление не найдено');
      const itemsText = shipment.items.map((it, i) => `${i + 1}. ${it.name} — ${it.quantity} шт — ${it.sum}`).join('\n');
      await ctx.answerCbQuery();
      return ctx.reply(`Опись от ${shipment.createdAt.toLocaleString()}:\n${itemsText}\n\nИтого: ${shipment.totalSum}`, mainMenu());
    } catch (err) {
      console.error('Error fetching shipment', err);
      return ctx.answerCbQuery('Ошибка при получении отправления');
    }
  }

  // default
  return ctx.answerCbQuery();
});

// --------------------
// Start bot and init Google Sheets
// --------------------
(async () => {
  await initGoogleSheets();
  await bot.launch();
  console.log('Bot started (polling)');
})();

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// --------------------
// Notes and next steps:
// - Make sure your Google Sheet has a sheet/tab named "orders" (or change range in appendRowToGoogleSheet)
// - Ensure your service account JSON file is accessible and the sheet is shared with the service account email
// - For production: consider setting up webhooks, logging, and proper error handling + admin controls
// - Keep your .env and service-account.json private (add to .gitignore)
// --------------------
