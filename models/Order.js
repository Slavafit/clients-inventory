const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  timestamp: { type: Date, default: Date.now },
  items: [
    {
      product: { type: String, required: true },
      quantity: { type: Number, required: true },
      total: { type: Number, required: true } // 💰 Общая сумма за позицию
    }
  ],
  totalSum: { type: Number, required: true }, // 💰 Общая сумма по всей описи
  status: { 
    type: String, 
    enum: ['новое', 'в обработке', 'отправлено', 'доставлено', 'отменено'], 
    default: 'новое' 
  } // 🚚 Статус отправления
});

module.exports = mongoose.model('Order', orderSchema);
