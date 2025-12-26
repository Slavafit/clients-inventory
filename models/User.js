const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, unique: true, sparse: true },
  whatsappId: { type: String, unique: true, sparse: true }, 
  phone: { type: String},
  name: { type: String },
  currentStep: { type: String, default: 'idle' },
  lastOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  role: { 
    type: String, 
    enum: ['user', 'admin'],
    default: 'user' 
  },
  
  tempProductName: { type: String },
  tempCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  // ID выбранного товара для ожидания количества
  tempProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  tempAdminOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' }, // Для хранения ID заказа при установке трека
  tempTrackNumber: { type: String }, //для временного хранения трека
  currentOrder: [
    {
      product: String,
      quantity: Number,
      total: Number
    }
  ]
});

module.exports = mongoose.model('User', userSchema);