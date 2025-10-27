require('dotenv').config();
const mongoose = require('mongoose');
const Category = require('./models/Category');
const Product = require('./models/Product');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  const data = [
    { emoji: '🧥', name: 'Одежда', products: ['Куртка', 'Брюки', 'Футболка', 'Платье', 'Кроссовки', 'Сапоги', 'Ботинки', 'Сандали'] },
    { emoji: '🥫', name: 'Продукты', products: ['Масло оливковое', 'Шоколад', 'Конфеты', 'Печенье', 'Кофе'] },
    { emoji: '🧴', name: 'Бытовые товары', products: ['Мыло', 'Шампунь', 'Зубная паста', 'Бумажные полотенца', 'Средство для мытья посуды'] },
    { emoji: '🎁', name: 'Другое', products: ['➕ Ввести свой товар'] }
  ];

  await Category.deleteMany();
  await Product.deleteMany();

  for (const cat of data) {
    const category = await Category.create({ name: cat.name, emoji: cat.emoji });
    const products = cat.products.map(name => ({ name, categoryId: category._id }));
    await Product.insertMany(products);
  }

  console.log('✅ Категории и товары добавлены.');
  await mongoose.disconnect();
})();
