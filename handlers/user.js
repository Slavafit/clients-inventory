// handlers/user.js
const { Markup } = require('telegraf');
const mongoose = require('mongoose');

// --- Вспомогательные функции (экспортируем showMainMenu отдельно) ---

async function showMainMenu(ctx) {
    return ctx.reply('📋 Главное меню. Выберите действие:', Markup.keyboard([
        ['📦 Создать опись', '🧾 Мои отправления'],
        ['✏️ Мои черновики', '🆘 Связаться с оператором'],
        ['🔄 Изменить номер']
    ]).resize());
}

async function showOrderPreview(ctx, user) {
    const items = user.currentOrder.map((i, idx) => {
        const itemTotal = i.total && !isNaN(i.total) ? i.total : 0;
        return `${idx + 1}. ${i.product} — ${i.quantity}шт, всего *${itemTotal.toFixed(2)}€*`;
    }).join('\n');

    const total = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);

    const buttons = user.currentOrder.map((i, idx) => [
        { text: `🗑 Удалить ${i.product}`, callback_data: `del_${idx}` }
    ]);
    buttons.push([
        { text: '➕ Добавить товар', callback_data: 'add_more' },
        { text: '✅ Отправить опись', callback_data: 'send_order' }
    ]);
    buttons.push([{ text: '❌ Отменить', callback_data: 'cancel_order' }]);

    await ctx.reply(`📦 Текущая опись:\n\n${items}\n\nИтого: ${total.toFixed(2)}€`, {
        reply_markup: { inline_keyboard: buttons }
    });
}

// --- Основная функция регистрации хендлеров ---
function registerUserHandlers(bot, { 
    User, 
    Order, 
    Product, 
    Category, 
    googleSheetsService, 
    showCategorySelection 
}) {

    // 1. Создать опись
    bot.hears('📦 Создать опись', async (ctx) => {
        const user = await User.findOne({ telegramId: ctx.from.id });
        user.currentOrder = [];
        user.currentStep = 'idle';
        user.lastOrderId = null;
        await user.save();
        await showCategorySelection(ctx);
    });

    // 2. Мои отправления
    bot.hears('🧾 Мои отправления', async (ctx) => {
        const user = await User.findOne({ telegramId: ctx.from.id });
        let currentPhone = user.phone;
        if (currentPhone && !currentPhone.startsWith('+')) currentPhone = '+' + currentPhone;

        if (!currentPhone) return ctx.reply('⚠️ Пожалуйста, сначала привяжите номер телефона.');

        const orders = await Order.find({
            clientPhone: currentPhone,
            status: { $ne: 'nuevo' }
        }).sort({ createdAt: -1 });

        if (!orders.length) return ctx.reply(`📭 У вас пока нет отправлений.`);

        let text = `📦 *Ваши отправления (по номеру ${currentPhone}):*\n\n`;
        orders.forEach((o, i) => {
            const date = o.createdAt ? o.createdAt.toLocaleDateString() : 'Неизвестно';
            const trackInfo = o.trackingNumber ? `\n🚛 Трек: \`${o.trackingNumber}\`` : '';
            const linkInfo = o.trackingUrl ? `\n🔗 [Отследить посылку](${o.trackingUrl})` : '';

            text += `🔹 *Заказ #${i + 1} от ${date}*\n💰 Сумма: ${o.totalSum.toFixed(2)}€\n🚦 Статус: *${o.status}*\n${trackInfo}${linkInfo}\n──────────────────\n`;
        });
        await ctx.reply(text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    });

    // 3. Мои черновики
    bot.hears('✏️ Мои черновики', async (ctx) => {
        const user = await User.findOne({ telegramId: ctx.from.id });
        let currentPhone = user.phone;
        if (!currentPhone) return ctx.reply('⚠️ Сначала привяжите номер телефона.');
        if (!currentPhone.startsWith('+')) currentPhone = '+' + currentPhone;

        const drafts = await Order.find({
            clientPhone: currentPhone,
            status: 'nuevo'
        }).sort({ createdAt: -1 });

        if (!drafts.length) return ctx.reply('🙌 У вас нет активных черновиков.');

        const draftButtons = drafts.map((d, i) => [{
            text: `Черновик #${i + 1} от ${d.createdAt.toLocaleDateString()} (${d.totalSum.toFixed(2)}€)`,
            callback_data: `edit_order_${d._id}`
        }]);

        await ctx.reply('✏️ Ваши черновики:', { reply_markup: { inline_keyboard: draftButtons } });
    });

    // 4. Отмена (Глобальная)
    bot.hears(['❌ Отмена', 'Cancel', 'cancel'], async (ctx) => {
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (user) {
            user.currentStep = 'idle';
            user.tempOrderId = null;
            user.newProductName = null;
            await user.save();
        }
        await ctx.reply('🛑 Действие отменено.', Markup.removeKeyboard());
        return showMainMenu(ctx);
    });

    // 5. Связь с оператором
    bot.hears('🆘 Связаться с оператором', async (ctx) => {
        const user = await User.findOne({ telegramId: ctx.from.id });
        user.currentStep = 'awaiting_support_message';
        await user.save();
        await ctx.reply('👨‍💻 Опишите вашу проблему одним сообщением:', Markup.keyboard([['❌ Отмена']]).resize());
    });

    // --- ЛОГИКА ВЫБОРА КАТЕГОРИЙ И ТОВАРОВ ---
    
    // Добавление кастомного товара
    bot.action('add_custom_product', async (ctx) => {
        await ctx.answerCbQuery();
        const user = await User.findOne({ telegramId: ctx.from.id });
        user.currentStep = 'awaiting_custom_product';
        await user.save();
        return ctx.editMessageText('✍️ Введите название товара:');
    });

    // Выбор категории
    bot.action(/cat_.+/, async (ctx) => {
        await ctx.answerCbQuery();
        const callbackData = ctx.match[0];
        if (callbackData.startsWith('select_cat_final_') || callbackData.startsWith('cat_final_')) return;

        const categoryId = callbackData.split('_').pop();
        if (!mongoose.Types.ObjectId.isValid(categoryId)) return ctx.answerCbQuery('⚠️ Ошибка ID');

        const category = await Category.findById(categoryId);
        const products = await Product.find({ categoryId }).sort({ name: 1 });

        const buttons = products.map(p => [{ text: p.name, callback_data: `prod_${p._id}` }]);
        await ctx.editMessageText(`📝 Категория: *${category.emoji} ${category.name}*. Выберите товар:`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    });

    // Выбор товара
    bot.action(/prod_.+/, async (ctx) => {
        const productId = ctx.match[0].replace('prod_', '');
        const product = await Product.findById(productId);
        const user = await User.findOne({ telegramId: ctx.from.id });

        if (product.name.includes('Ввести свой')) {
            user.currentStep = 'awaiting_custom_product';
            await user.save();
            await ctx.reply('Введите название своего товара:');
        } else {
            user.currentOrder.push({ product: product.name, quantity: 0, total: 0 });
            user.currentStep = 'awaiting_quantity';
            await user.save();
            await ctx.reply(`Введите количество для "${product.name}":`);
        }
    });

    // --- КНОПКИ УПРАВЛЕНИЯ ЗАКАЗОМ ---

    bot.action(/del_\d+/, async (ctx) => {
        const index = parseInt(ctx.match[0].replace('del_', ''));
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (user.currentOrder[index]) {
            user.currentOrder.splice(index, 1);
            await user.save();
            await ctx.answerCbQuery('🗑 Товар удалён');
            await showOrderPreview(ctx, user);
        } else {
            await ctx.answerCbQuery('⚠️ Элемент не найден');
        }
    });

    bot.action('add_more', async (ctx) => {
        await ctx.answerCbQuery();
        await showCategorySelection(ctx);
    });

    bot.action('cancel_order', async (ctx) => {
        await ctx.answerCbQuery();
        const user = await User.findOne({ telegramId: ctx.from.id });
        user.currentOrder = [];
        user.currentStep = 'idle';
        user.lastOrderId = null;
        await user.save();
        await ctx.reply('❌ Опись отменена.');
        await showMainMenu(ctx);
    });

    bot.action('send_order', async (ctx) => {
        await ctx.answerCbQuery();
        const user = await User.findOne({ telegramId: ctx.from.id });
        if (!user || !user.currentOrder.length) return ctx.reply('Ошибка: нет товаров.');

        const total = user.currentOrder.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);
        let currentPhone = user.phone;
        let order;

        if (user.lastOrderId) {
            const existingOrder = await Order.findById(user.lastOrderId);
            if (existingOrder && existingOrder.status === 'nuevo') {
                order = await Order.findByIdAndUpdate(user.lastOrderId, {
                    clientPhone: currentPhone,
                    items: user.currentOrder,
                    totalSum: total,
                }, { new: true });
            }
        }

        if (!order) {
            order = await Order.create({
                userId: user._id,
                clientPhone: currentPhone,
                items: user.currentOrder,
                totalSum: total,
                status: 'nuevo'
            });
        }

        user.currentOrder = [];
        user.currentStep = 'idle';
        user.lastOrderId = order._id;
        await user.save();

        await ctx.editMessageText(
            `✅ Сохранено как *Черновик*. Вы можете редактировать или отправить.`,
            {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✏️ Редактировать', callback_data: `edit_order_${order._id}` }],
                        [{ text: '🚀 Окончательно отправить', callback_data: `final_send_${order._id}` }]
                    ]
                }
            }
        );
    });

    bot.action(/edit_order_.+/, async (ctx) => {
        await ctx.answerCbQuery('Загружаю...');
        const orderId = ctx.match[0].replace('edit_order_', '');
        const order = await Order.findById(orderId);

        if (!order || order.status !== 'nuevo') return ctx.editMessageText('⚠️ Нельзя редактировать.');

        const user = await User.findOne({ telegramId: ctx.from.id });
        user.currentOrder = order.items;
        user.lastOrderId = orderId;
        user.currentStep = 'confirm_order';
        await user.save();
        await ctx.editMessageText(`✏️ Редактирование заказа ID ${orderId}.`);
        return showOrderPreview(ctx, user);
    });

    bot.action(/final_send_.+/, async (ctx) => {
        await ctx.answerCbQuery('Отправляю...');
        const orderId = ctx.match[0].replace('final_send_', '');
        const order = await Order.findById(orderId);

        if (!order || order.status !== 'nuevo') return ctx.editMessageText('⚠️ Ошибка.');

        // Запись в Google Sheets
        await googleSheetsService.appendOrderToSheet(order);

        order.status = 'en tramito';
        await order.save();
        await User.findOneAndUpdate({ telegramId: ctx.from.id }, { lastOrderId: null, currentStep: 'idle' });

        await ctx.editMessageText(`🚀 Опись ID ${orderId} отправлена!`);
        await showMainMenu(ctx);
    });

    // --- ГЛАВНЫЙ ОБРАБОТЧИК ТЕКСТА (USER) ---
    bot.on('text', async (ctx, next) => {
        // Если это команда (например, /admin) — пропускаем (она не должна попасть в логику заказа)
        if (ctx.message.text.startsWith('/')) {
             return next(); 
        }

        const user = await User.findOne({ telegramId: ctx.from.id });
        const text = ctx.message.text.trim();

        // Логика автоматического определения номера
        if (!user || !user.phone) {
            const cleanedText = text.replace(/[^0-9+]/g, '');
            if (cleanedText.length >= 9 && /^[\d+]/.test(text)) {
                let formattedPhone = cleanedText;
                if (!formattedPhone.startsWith('+')) formattedPhone = '+' + formattedPhone;

                user.phone = formattedPhone;
                user.currentStep = 'idle';
                await user.save();
                await ctx.reply(`✅ Ваш номер сохранён: ${formattedPhone}`);
                return showMainMenu(ctx);
            }
        }

        switch (user.currentStep) {
            case 'awaiting_custom_product':
                user.currentOrder.push({ product: text, quantity: 0, total: 0 });
                user.currentStep = 'awaiting_quantity';
                await user.save();
                return ctx.reply('Введите количество:');

            case 'awaiting_quantity':
                const qty = parseInt(text);
                if (!qty || qty <= 0) return ctx.reply('Введите корректное число.');
                if (user.currentOrder.length === 0) {
                     user.currentStep = 'idle'; await user.save();
                     return ctx.reply('⚠️ Ошибка. Начните заново.');
                }
                user.currentOrder[user.currentOrder.length - 1].quantity = qty;
                user.currentStep = 'awaiting_total';
                await user.save();
                return ctx.reply('💰 Введите *общую сумму* за эту позицию (например, 19.99):', { parse_mode: 'Markdown' });

            case 'awaiting_total':
                const total = parseFloat(text.replace(',', '.'));
                if (isNaN(total) || total < 0) return ctx.reply('Введите корректную сумму.');
                user.currentOrder[user.currentOrder.length - 1].total = total;
                user.currentStep = 'confirm_order';
                await user.save();
                return showOrderPreview(ctx, user);

            case 'confirm_order':
                return ctx.reply('👇 Используйте кнопки под описью.');

            case 'awaiting_new_phone':
                const cleanedPhone = text.replace(/[^0-9]/g, '');
                if (cleanedPhone.length < 9) return ctx.reply('❌ Некорректный номер.');
                let fPhone = text.trim();
                if (!fPhone.startsWith('+')) fPhone = '+' + fPhone;
                user.phone = fPhone;
                user.currentStep = 'idle';
                await user.save();
                await ctx.reply(`✅ Новый номер сохранён: ${fPhone}`);
                return showMainMenu(ctx);

            case 'awaiting_support_message':
                const msgToAdmin = `🆘 <b>ВОПРОС ОТ КЛИЕНТА</b>\n👤 От: ${ctx.from.first_name} (ID: ${ctx.from.id})\n📞 Тел: ${user.phone}\n\n💬: ${text}`;
                try {
                    await bot.telegram.sendMessage(process.env.ADMIN_ID, msgToAdmin, { parse_mode: 'HTML' });
                    await ctx.reply('✅ Сообщение отправлено!');
                } catch (e) { await ctx.reply('❌ Ошибка.'); }
                user.currentStep = 'idle';
                await user.save();
                return showMainMenu(ctx);

            default:
                return ctx.reply('🤔 Я не понимаю эту команду. Воспользуйтесь меню.');
        }
    });
}

module.exports = {
    registerUserHandlers,
    showMainMenu,
    showOrderPreview
};