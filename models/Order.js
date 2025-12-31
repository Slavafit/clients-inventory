const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  clientPhone: { type: String, required: true },
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
    enum: ['nuevo', 'en tramito', 'enviado', 'entregado', 'cancelado'], 
    default: 'nuevo' 
  },
  trackingNumber: { type: String, default: '' },
  trackingUrl: { type: String, default: '' },
  }, {
  timestamps: true 
});

module.exports = mongoose.model('Order', orderSchema);
