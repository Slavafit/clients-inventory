/*
Telegram Order Bot with SQLite persistence (Node.js, Telegraf)

Features:
- Identification by phone number (contact or manual input)
- Choose product from a predefined list or enter custom one
- Input quantity (in pieces)
- Input custom price
- Saves each order to Google Sheets or local Excel
- User state and order history stored in SQLite (persistent)

Setup:
1) Create a Telegram bot with @BotFather and get BOT_TOKEN.
2) Create a Google Service Account and enable Google Sheets API, share your sheet, etc. (optional)
3) Set environment variables:
   BOT_TOKEN=your_token_here
   USE_GOOGLE_SHEETS=true
   GOOGLE_SHEETS_KEYFILE=./service-account.json
   GOOGLE_SHEET_ID=your_sheet_id
   EXCEL_FILE=./orders.xlsx
4) Run: npm install telegraf googleapis xlsx dotenv better-sqlite3
5) Start: node telegram-order-bot.js
*/

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fs = require('fs');
const { google } = require('googleapis');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');

// --- Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
const USE_GOOGLE_SHEETS = (process.env.USE_GOOGLE_SHEETS || 'true').toLowerCase() === 'true';
const GOOGLE_SHEETS_KEYFILE = process.env.GOOGLE_SHEETS_KEYFILE || './service-account.json';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const EXCEL_FILE = process.env.EXCEL_FILE || './orders.xlsx';

// --- DB init ---
const db = new Database('botdata.sqlite');
db.prepare(`CREATE TABLE IF NOT EXISTS users (
  telegram_id INTEGER PRIMARY KEY,
  phone TEXT,
  step TEXT,
  product TEXT,
  quantity INTEGER,
  price REAL
)`).run();

db.prepare(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT,
  phone TEXT,
  telegram_id INTEGER,
  product TEXT,
  quantity INTEGER,
  price REAL,
  total REAL
)`).run();

// --- Google Sheets ---
let sheetsClient = null;
async function initGoogleSheets() {
  if (!USE_GOOGLE_SHEETS) return;
  if (!fs.existsSync(GOOGLE_SHEETS_KEYFILE)) {
    console.error('Google keyfile not found, disabling Sheets');
    return;
  }
  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_SHEETS_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('Google Sheets ready');
}

async function appendRowToGoogleSheet(row) {
  const resource = { values: [row] };
  await sheetsClient.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEET_ID,
    range: 'Sheet1!A:Z',
    valueInputOption: 'USER_ENTERED',
    requestBody: resource,
  });
}

function appendRowToExcel(row) {
  let workbook;
  if (fs.existsSync(EXCEL_FILE)) workbook = XLSX.readFile(EXCEL_FILE);
  else {
    workbook = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([['Timestamp','Phone','TelegramID','Product','Quantity','Price','Total']]);
    XLSX.utils.book_append_sheet(workbook, ws, 'Orders');
  }
  const ws = workbook.Sheets['Orders'];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
  data.push(row);
  const newWs = XLSX.utils.aoa_to_sheet(data);
  workbook.Sheets['Orders'] = newWs;
  XLSX.writeFile(workbook, EXCEL_FILE);
}

// --- Bot ---
const bot = new Telegraf(BOT_TOKEN);
const PRODUCTS = ['Product A','Product B','Product C','Other (enter manually)'];

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE telegram_id=?').get(id);
}
function saveUser(u) {
  db.prepare(`INSERT INTO users (telegram_id, phone, step, product, quantity, price)
    VALUES (@telegram_id,@phone,@step,@product,@quantity,@price)
    ON CONFLICT(telegram_id) DO UPDATE SET
      phone=excluded.phone,
      step=excluded.step,
      product=excluded.product,
      quantity=excluded.quantity,
      price=excluded.price`).run(u);
}
function resetUser(id, phone) {
  db.prepare('UPDATE users SET step="ready", product=NULL, quantity=NULL, price=NULL WHERE telegram_id=?').run(id);
  if (phone) db.prepare('UPDATE users SET phone=? WHERE telegram_id=?').run(phone, id);
}

bot.start(async (ctx) => {
  const user = getUser(ctx.from.id);
  if (user && user.phone) {
    await ctx.reply('С возвращением! Ваш номер уже сохранён.');
    return sendProductMenu(ctx);
  }
  await ctx.reply('Привет! Отправьте номер телефона (через кнопку или вручную).',
    Markup.keyboard([[Markup.button.contactRequest('📱 Поделиться номером')]]).oneTime().resize());
});

bot.on('contact', async (ctx) => {
  const phone = ctx.message.contact.phone_number;
  saveUser({ telegram_id: ctx.from.id, phone, step: 'ready' });
  await ctx.reply(`Номер сохранён: ${phone}`);
  await sendProductMenu(ctx);
});

bot.on('text', async (ctx) => {
  const id = ctx.from.id;
  const text = ctx.message.text.trim();
  let user = getUser(id);
  if (!user || !user.phone) {
    const phoneCandidate = text.replace(/\s+/g, '');
    if (/^\+?\d{7,15}$/.test(phoneCandidate)) {
      saveUser({ telegram_id: id, phone: phoneCandidate, step: 'ready' });
      await ctx.reply(`Номер сохранён: ${phoneCandidate}`);
      return sendProductMenu(ctx);
    } else {
      return ctx.reply('Пожалуйста, отправьте корректный номер телефона.');
    }
  }

  switch (user.step) {
    case 'awaiting_custom_product':
      user.product = text;
      user.step = 'awaiting_quantity';
      saveUser(user);
      return ctx.reply('Введите количество (в штуках):');
    case 'awaiting_quantity': {
      const qty = parseInt(text.replace(/[^0-9]/g, ''), 10);
      if (!qty || qty <= 0) return ctx.reply('Введите количество числом > 0');
      user.quantity = qty;
      user.step = 'awaiting_price';
      saveUser(user);
      return ctx.reply('Введите цену за единицу:');
    }
    case 'awaiting_price': {
      const price = parseFloat(text.replace(',', '.'));
      if (isNaN(price) || price < 0) return ctx.reply('Введите корректную цену.');
      user.price = price;
      user.step = 'confirm';
      saveUser(user);
      const total = (user.quantity * user.price).toFixed(2);
      return ctx.reply(`Проверьте:\nТовар: ${user.product}\nКоличество: ${user.quantity}\nЦена: ${user.price}\nИтого: ${total}`,
        Markup.inlineKeyboard([
          [Markup.button.callback('✅ Подтвердить', 'confirm_save')],
          [Markup.button.callback('❌ Отменить', 'cancel')]
        ]));
    }
    default:
      return ctx.reply('Нажмите /start чтобы начать.');
  }
});

async function sendProductMenu(ctx) {
  const buttons = PRODUCTS.map(p => [Markup.button.callback(p, `prod_${p}`)]);
  await ctx.reply('Выберите товар или введите свой:', Markup.inlineKeyboard(buttons));
}

bot.on('callback_query', async (ctx) => {
  const id = ctx.from.id;
  const data = ctx.callbackQuery.data;
  let user = getUser(id) || { telegram_id: id, step: 'ready' };

  if (data.startsWith('prod_')) {
    const product = data.slice(5);
    if (product === 'Other (enter manually)') {
      user.step = 'awaiting_custom_product';
      saveUser(user);
      await ctx.answerCbQuery();
      return ctx.reply('Введите название товара:');
    }
    user.product = product;
    user.step = 'awaiting_quantity';
    saveUser(user);
    await ctx.answerCbQuery(`Вы выбрали: ${product}`);
    return ctx.reply('Введите количество (в штуках):');
  }

  if (data === 'confirm_save') {
    await ctx.answerCbQuery('Сохраняем...');
    await handleSave(ctx);
  }

  if (data === 'cancel') {
    resetUser(id);
    await ctx.answerCbQuery('Отменено');
    return ctx.reply('Отменено. Нажмите /start чтобы начать заново.');
  }
});

async function handleSave(ctx) {
  const id = ctx.from.id;
  const user = getUser(id);
  if (!user.product || !user.quantity || user.price == null) return ctx.reply('Данные неполные.');
  const total = (user.quantity * user.price).toFixed(2);
  const timestamp = new Date().toISOString();
  const row = [timestamp, user.phone, id.toString(), user.product, user.quantity.toString(), user.price.toString(), total];

  db.prepare('INSERT INTO orders (timestamp, phone, telegram_id, product, quantity, price, total) VALUES (?,?,?,?,?,?,?)')
    .run(timestamp, user.phone, id, user.product, user.quantity, user.price, total);

  try {
    if (USE_GOOGLE_SHEETS && sheetsClient) await appendRowToGoogleSheet(row);
    else appendRowToExcel(row);
    await ctx.reply('✅ Заказ сохранён! Спасибо.');
  } catch (err) {
    console.error('Save error:', err);
    await ctx.reply('Ошибка при сохранении.');
  }
  resetUser(id, user.phone);
  await sendProductMenu(ctx);
}

bot.catch((err, ctx) => console.error('Bot error:', err));

(async () => {
  await initGoogleSheets();
  bot.launch();
  console.log('Bot started with SQLite persistence');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
