// handlers/whatsappUI.js (Вам нужно будет импортировать Product, Category и whatsappClient)

const Category = require('../models/Category');
const Product = require('../models/Product'); 
const { sendListMessage, sendTextMessage } = require('../whatsappClient');

/**
 * Показывает список категорий в формате WhatsApp Interactive List.
 */
async function showCategorySelection(whatsappId) {
    const categories = await Category.find({});

    if (!categories.length) {
        return sendTextMessage(whatsappId, 'В системе пока нет категорий для описи.');
    }
    
    // 1. Создаем элементы списка для категорий
    const categoryRows = categories.map(cat => ({
        id: `cat_${cat._id}`, // Используем ваш callback_data
        title: `${cat.emoji} ${cat.name}`,
        description: 'Выберите, чтобы увидеть товары'
    }));

    // 2. Добавляем кнопку "Другое / Свой товар"
    categoryRows.push({
        id: 'add_custom_product',
        title: '➕ Другое / Добавить свой товар',
        description: 'Товар, который не в списке'
    });

    const sections = [{
        title: "Доступные категории",
        rows: categoryRows
    }];

    await sendListMessage(
        whatsappId, 
        "📋 Новая опись",
        "Выберите категорию, чтобы увидеть товары:",
        "Выбрать категорию", // Текст основной кнопки
        sections
    );
}

/**
 * Показывает список товаров в выбранной категории (сортировка по алфавиту).
 */
async function showProductSelection(whatsappId, categoryId, categoryName) {
    // 🚨 Сортировка товаров по алфавиту (как вы и просили)
    const products = await Product.find({ categoryId }).sort({ name: 1 }); 

    if (!products.length) {
        return sendTextMessage(whatsappId, `В категории "${categoryName}" нет товаров.`);
    }

    const productRows = products.map(prod => ({
        id: `prod_${prod._id}`, // Используем ваш callback_data
        title: prod.name
    }));

    const sections = [{
        title: `Товары в ${categoryName}`,
        rows: productRows
    }];

    await sendListMessage(
        whatsappId, 
        "📝 Выбор товара",
        `Вы выбрали: ${categoryName}. Выберите товар для добавления в опись:`,
        "Выбрать товар", 
        sections
    );
}

module.exports = {
    showCategorySelection,
    showProductSelection
};