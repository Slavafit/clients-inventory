// whatsappUI.js
const Category = require('./models/Category');
const Product = require('./models/Product');
const { sendListMessage, sendTextMessage, sendReplyButtons } = require('./whatsappClient');

// 1. Главное меню
async function showMainMenu(whatsappId) {
    return sendListMessage(
        whatsappId,
        "Главное меню",
        "Выберите действие:",
        "Меню",
        [{
            title: "Функции",
            rows: [
                { id: 'menu_create_order', title: '📦 Создать опись', description: 'Начать новый заказ' },
                { id: 'menu_my_orders', title: '🧾 Мои отправления', description: 'История заказов' },
                { id: 'menu_drafts', title: '✏️ Мои черновики', description: 'Незавершенные заказы' },
                { id: 'menu_support', title: '🆘 Оператор', description: 'Связаться с поддержкой' }
            ]
        }]
    );
}

// 2. Выбор категорий
async function showCategorySelection(whatsappId) {
    const categories = await Category.find({});
    
    // Формируем строки для списка
    const categoryRows = categories.map(cat => ({
        id: `cat_${cat._id}`,
        title: cat.name.substring(0, 24), // WhatsApp имеет лимит на длину заголовка
        description: 'Показать товары'
    }));

    // Добавляем "Свой товар"
    categoryRows.push({
        id: 'add_custom_product',
        title: '➕ Свой товар',
        description: 'Ввести название вручную'
    });

    await sendListMessage(
        whatsappId,
        "Категории",
        "Выберите категорию товаров:",
        "Открыть список",
        [{ title: "Категории", rows: categoryRows }]
    );
}

// 3. Выбор товара
async function showProductSelection(whatsappId, categoryId) {
    const products = await Product.find({ categoryId }).sort({ name: 1 });
    
    if (!products.length) return sendTextMessage(whatsappId, "В этой категории нет товаров.");

    const productRows = products.map(prod => ({
        id: `prod_${prod._id}`,
        title: prod.name.substring(0, 24)
    }));

    await sendListMessage(
        whatsappId,
        "Товары",
        "Выберите товар из списка:",
        "Товары",
        [{ title: "Список", rows: productRows }]
    );
}

// 4. Превью заказа (Используем КНОПКИ для действий)
async function showOrderPreview(whatsappId, user) {
    let msg = `📦 *Ваша опись:*\n`;
    let total = 0;

    user.currentOrder.forEach((item, idx) => {
        msg += `${idx + 1}. ${item.product} x ${item.quantity} = ${item.total}€\n`;
        total += item.total;
    });

    msg += `\n💰 *Итого:* ${total.toFixed(2)}€`;

    // WhatsApp разрешает только 3 кнопки в Interactive Button message
    await sendReplyButtons(
        whatsappId,
        msg,
        [
            { id: 'add_more', title: '➕ Еще товар' },
            { id: 'send_order', title: '✅ Отправить' },
            { id: 'cancel_order', title: '❌ Удалить всё' }
        ]
    );
}

module.exports = { showMainMenu, showCategorySelection, showProductSelection, showOrderPreview };