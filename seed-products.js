// seed-products.js
const mongoose = require('mongoose');
const Category = require('./models/Category');
const Product = require('./models/Product');
require('dotenv').config();

// Подключение к MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Подключено к MongoDB'))
  .catch(err => console.error('❌ Ошибка подключения:', err));

// Категории с эмодзи
const categories = [
  { name: 'Мужская одежда', emoji: '👨‍💼' },
  { name: 'Женская одежда', emoji: '👗' },
  { name: 'Детская одежда', emoji: '👶' }
];

// Товары — только базовые названия (без "мужские", "женские", "детские")
const products = [
  // 👨‍💼 Мужская одежда
  { name: 'Джинсы', category: 'Мужская одежда' },
  { name: 'Брюки', category: 'Мужская одежда' },
  { name: 'Рубашка', category: 'Мужская одежда' },
  { name: 'Футболка', category: 'Мужская одежда' },
  { name: 'Куртка', category: 'Мужская одежда' },
  { name: 'Пальто', category: 'Мужская одежда' },
  { name: 'Свитер', category: 'Мужская одежда' },
  { name: 'Галстук', category: 'Мужская одежда' },
  { name: 'Носки набор', category: 'Мужская одежда' },
  { name: 'Ремнь', category: 'Мужская одежда' },
  { name: 'Кроссовки', category: 'Мужская одежда' },
  { name: 'Ботинки', category: 'Мужская одежда' },
  { name: 'Туфли', category: 'Мужская одежда' },

  // 👗 Женская одежда
  { name: 'Платье', category: 'Женская одежда' },
  { name: 'Юбка', category: 'Женская одежда' },
  { name: 'Брюки', category: 'Женская одежда' },
  { name: 'Блузка', category: 'Женская одежда' },
  { name: 'Футболка', category: 'Женская одежда' },
  { name: 'Кофта', category: 'Женская одежда' },
  { name: 'Пальто', category: 'Женская одежда' },
  { name: 'Шарф', category: 'Женская одежда' },
  { name: 'Носки набор', category: 'Женская одежда' },
  { name: 'Пояс', category: 'Женская одежда' },
    { name: 'Кроссовки', category: 'Мужская одежда' },
  { name: 'Ботинки', category: 'Мужская одежда' },
  { name: 'Туфли', category: 'Мужская одежда' },

  // 👶 Детская одежда
  { name: 'Футболка набор', category: 'Детская одежда' },
  { name: 'Штаны', category: 'Детская одежда' },
  { name: 'Платье', category: 'Детская одежда' },
  { name: 'Свитер', category: 'Детская одежда' },
  { name: 'Куртка', category: 'Детская одежда' },
  { name: 'Шапка', category: 'Детская одежда' },
  { name: 'Носки набор', category: 'Детская одежда' },
  { name: 'Шорты', category: 'Детская одежда' },
  { name: 'Комбинезон', category: 'Детская одежда' },
    { name: 'Кроссовки', category: 'Детская одежда' },
  { name: 'Ботинки', category: 'Детская одежда' },
  { name: 'Сандалии', category: 'Детская одежда' },
];

async function seedDatabase() {
  try {
    // 1. Создаем категории
    const createdCategories = [];
    for (const cat of categories) {
      const existing = await Category.findOne({ name: cat.name });
      if (existing) {
        console.log(`🟡 Категория "${cat.name}" уже существует`);
        createdCategories.push(existing);
      } else {
        const newCat = await Category.create(cat);
        console.log(`✅ Категория создана: ${newCat.name} ${newCat.emoji}`);
        createdCategories.push(newCat);
      }
    }

    // 2. Создаем товары — без дублирования категории в названии
    let addedCount = 0;
    for (const prod of products) {
      const category = createdCategories.find(c => c.name === prod.category);
      if (!category) {
        console.error(`❌ Категория "${prod.category}" не найдена для товара "${prod.name}"`);
        continue;
      }

      const existing = await Product.findOne({ name: prod.name, categoryId: category._id });
      if (existing) {
        console.log(`🟡 Товар "${prod.name}" уже существует в категории "${prod.category}"`);
      } else {
        await Product.create({
          name: prod.name,
          categoryId: category._id
        });
        console.log(`✅ Товар добавлен: ${prod.name} → ${prod.category}`);
        addedCount++;
      }
    }

    console.log(`🎉 Готово! Добавлено уникальных товаров: ${addedCount}`);
    process.exit(0);

  } catch (error) {
    console.error('❌ Ошибка при заполнении базы:', error);
    process.exit(1);
  }
}

seedDatabase();