require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const { google } = require('googleapis');
const fs = require('fs');

const Category = require('./models/Category');
const Product = require('./models/Product');
const User = require('./models/User');
const Order = require('./models/Order');

// --- Подключение к MongoDB ---
mongoose.connect(process.env.MONGO_URI).then(() => console.log('MongoDB connected'));

// --- Google Sheets API ---
let sheetsClient = null;
if (process.env.USE_GOOGLE_SHEETS === 'true' && fs.existsSync(process.env.GOOGLE_SHEETS_KEYFILE)) {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_SHEETS_KEYFILE,
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  console.log('Google Sheets connected');
}

// --- Бот ---
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start(async (ctx) => {
  let user = await User.findOne({ telegramId: ctx.from.id });

  if (!user) {
    user = await User.create({ telegramId: ctx.from.id });
    await ctx.reply('Привет! Для начала отправьте свой номер телефона:',
      Markup.keyboard([[Markup.button.contactRequest('📱 Отправить номер')]]).oneTime().resize());
  } else if (user.phone) {
    await ctx.reply(`С возвращением, ${ctx.from.first_name}!`);
    return showMainMenu(ctx);
  } else {
    await ctx.reply('Пожалуйста, отправьте номер телефона:');
  }
});

bot.on('contact', async (ctx) => {
  const phone = ctx.message.contact.phone_number;
  await User.findOneAndUpdate({ telegramId: ctx.from.id }, { phone });
  await ctx.reply(`Ваш номер сохранён: ${phone}`);
  return showMainMenu(ctx);
});

// --- Главное меню ---
async function showMainMenu(ctx) {
  return ctx.reply('Выберите действие:', Markup.keyboard([
    ['📦 Создать опись', '🧾 Мои отправления']
  ]).resize());
}

// --- Создать опись ---
bot.hears('📦 Создать опись', async (ctx) => {
  const categories = await Category.find();
  const buttons = categories.map(c => [{ text: `${c.emoji} ${c.name}`, callback_data: `cat_${c._id}` }]);
  await ctx.reply('Выберите категорию товара:', { reply_markup: { inline_keyboard: buttons } });
});

// --- Мои отправления ---
bot.hears('🧾 Мои отправления', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) return ctx.reply('Сначала используйте /start.');

  const orders = await Order.find({ userId: user._id });
  if (!orders.length) return ctx.reply('У вас пока нет отправлений.');

  let text = '📋 Ваши отправления:\n\n';
  orders.forEach((o, i) => {
    text += `#${i + 1} от ${o.timestamp.toLocaleString()} — ${o.total}€\n`;
  });
  await ctx.reply(text);
});

// --- Обработка выбора категории ---
bot.action(/cat_.+/, async (ctx) => {
  const categoryId = ctx.match[0].replace('cat_', '');
  const category = await Category.findById(categoryId);
  const products = await Product.find({ categoryId });

  const buttons = products.map(p => [{ text: p.name, callback_data: `prod_${p._id}` }]);
  await ctx.reply(`Категория *${category.emoji} ${category.name}*`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: buttons }
  });
});

// --- Обработка выбора товара ---
bot.action(/prod_.+/, async (ctx) => {
  const productId = ctx.match[0].replace('prod_', '');
  const product = await Product.findById(productId);

  const user = await User.findOne({ telegramId: ctx.from.id });
  if (product.name.includes('Ввести свой')) {
    user.currentStep = 'awaiting_custom_product';
    await user.save();
    await ctx.reply('Введите название своего товара:');
  } else {
    user.currentOrder.push({ product: product.name });
    user.currentStep = 'awaiting_quantity';
    await user.save();
    await ctx.reply(`Введите количество для товара "${product.name}":`);
  }
});

// --- Пользовательский ввод ---
bot.on('text', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  if (!user) return ctx.reply('Сначала нажмите /start');

  const text = ctx.message.text.trim();

  switch (user.currentStep) {
    case 'awaiting_custom_product':
      user.currentOrder.push({ product: text });
      user.currentStep = 'awaiting_quantity';
      await user.save();
      return ctx.reply('Введите количество:');

    case 'awaiting_quantity':
      const qty = parseInt(text);
      if (!qty || qty <= 0) return ctx.reply('Введите корректное количество.');
      user.currentOrder[user.currentOrder.length - 1].quantity = qty;
      user.currentStep = 'awaiting_price';
      await user.save();
      return ctx.reply('Введите цену за единицу:');

    case 'awaiting_price':
      const price = parseFloat(text.replace(',', '.'));
      if (isNaN(price)) return ctx.reply('Введите число.');
      user.currentOrder[user.currentOrder.length - 1].price = price;
      user.currentStep = 'confirm_order';
      await user.save();

      const items = user.currentOrder.map(i => `${i.product} — ${i.quantity}шт × ${i.price}€`).join('\n');
      const total = user.currentOrder.reduce((s, i) => s + i.quantity * i.price, 0);
      return ctx.reply(`Проверьте опись:\n\n${items}\n\nИтого: ${total}€`, Markup.inlineKeyboard([
        [Markup.button.callback('✅ Отправить опись', 'send_order')],
        [Markup.button.callback('➕ Добавить товар', 'add_more')]
      ]));
  }
});

// --- Добавить ещё товар ---
bot.action('add_more', async (ctx) => {
  await ctx.answerCbQuery();
  return bot.hears('📦 Создать опись')(ctx);
});

// --- Отправить опись ---
bot.action('send_order', async (ctx) => {
  const user = await User.findOne({ telegramId: ctx.from.id });
  const total = user.currentOrder.reduce((s, i) => s + i.quantity * i.price, 0);

  const order = await Order.create({
    userId: user._id,
    items: user.currentOrder,
    total
  });

  // Google Sheets
  if (sheetsClient) {
    const values = [
      [new Date().toISOString(), user.phone, JSON.stringify(order.items), total]
    ];
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:Z',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values }
    });
  }

  user.currentOrder = [];
  user.currentStep = 'idle';
  await user.save();

  await ctx.reply('✅ Опись успешно отправлена!');
  await showMainMenu(ctx);
});

bot.launch();
console.log('Bot started...');
