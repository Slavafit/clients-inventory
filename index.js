require('dotenv').config();
const { Telegraf } = require('telegraf');
const mongoose = require('mongoose');

// Модели
const Category = require('./models/Category');
const Product = require('./models/Product');
const User = require('./models/User');
const Order = require('./models/Order');

// Сервисы
const adminService = require('./services/adminService');
const googleSheetsService = require('./services/googleSheets');

// Хендлеры (импортируем)
const registerAdminHandlers = require('./handlers/admin');
const registerAuthHandlers = require('./handlers/auth');

// 🔥 Импортируем функцию регистрации И меню из нового файла
const { registerUserHandlers, showMainMenu } = require('./handlers/user');

const { checkAuth } = require('./middlewares/checkAuth');
const { callbackDebug } = require('./middlewares/callbackDebug');
const { 
    showCategorySelection, 
    showAdminCategorySelection 
} = require('./handlers/category');

// --- Подключение к БД ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('MongoDB error:', err.message));

// Запускаем Google Sheets
googleSheetsService.initGoogleSheets();

// --- Инициализация бота ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// --- 1. АВТОРИЗАЦИЯ (/start, contact) ---
// Передаем showMainMenu, которое мы импортировали из handlers/user.js
registerAuthHandlers(bot, User, showMainMenu);

// --- 2. MIDDLEWARE (Защита) ---
bot.use(checkAuth(User));
bot.use(callbackDebug());

// --- 3. АДМИНСКАЯ ЛОГИКА ---
registerAdminHandlers(bot, {
  User,
  Order,
  Product,
  Category,
  adminService,
  showAdminCategorySelection
});

// --- 4. ПОЛЬЗОВАТЕЛЬСКАЯ ЛОГИКА (Всё остальное) ---
// Передаем все необходимые модели и сервисы, включая showCategorySelection
registerUserHandlers(bot, { 
    User, 
    Order, 
    Product, 
    Category, 
    googleSheetsService, 
    showCategorySelection 
});

// --- Обработка ошибок ---
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('⚠️ Произошла ошибка. Попробуйте ещё раз.');
});

// Запуск
bot.launch().then(() => console.log('🚀 Бот запущен'));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));