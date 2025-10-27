require('dotenv').config();
const mongoose = require('mongoose');
const Order = require('./models/Order');
const User = require('./models/User');
const Product = require('./models/Product');
const Category = require('./models/Category');

(async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    await Promise.all([
      Order.deleteMany({}),
      User.deleteMany({}),
      Product.deleteMany({}),
      Category.deleteMany({})
    ]);
    console.log('✅ База данных очищена полностью');
    process.exit(0);
  } catch (err) {
    console.error('Ошибка очистки:', err);
    process.exit(1);
  }
})();
