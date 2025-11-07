// handlers/category.js

const { Markup } = require('telegraf'); // Нужен для кнопок
const Category = require('../models/Category'); // Нужен для поиска категорий

// 1. Функция для АДМИНИСТРАТОРА (Добавление товара)
async function showAdminCategorySelection(ctx) {
    const categories = await Category.find({});

    if (!categories.length) {
        return ctx.editMessageText('⚠️ Сначала необходимо добавить категории с помощью команды /addcat.');
    }

    const categoryButtons = categories.map(cat => {
        return [
            { 
                text: `${cat.emoji} ${cat.name}`, 
                // Важный префикс для админа
                callback_data: `select_cat_final_${cat._id}` 
            }
        ];
    });

    const messageText = '📝 Выберите категорию, в которую необходимо добавить товар:';
    await ctx.reply(messageText, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: categoryButtons }
    });
}

// 2. Функция для ПОЛЬЗОВАТЕЛЯ (Опись)
async function showCategorySelection(ctx) {
    const categories = await Category.find({});

    if (!categories.length) {
        return ctx.reply('В системе пока нет категорий.');
    }
    
    // Префикс для обычного пользователя
    const buttons = categories.map(cat => 
        [{ text: `${cat.emoji} ${cat.name}`, callback_data: `cat_${cat._id}` }]
    );

    await ctx.reply('Выберите категорию:', Markup.inlineKeyboard(buttons));
}


module.exports = { 
    showCategorySelection,
    showAdminCategorySelection 
};