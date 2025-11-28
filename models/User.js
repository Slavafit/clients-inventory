const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  // 🟢 НОВОЕ ПОЛЕ: ID пользователя WhatsApp (его номер телефона)
  whatsappId: { type: String, unique: true, sparse: true }, 
  
  phone: { type: String},
  currentStep: { type: String, default: 'idle' },
  lastOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
  role: { 
    type: String, 
    enum: ['user', 'admin'],
    default: 'user' 
  },
  
  tempProductName: { type: String },
  tempCategoryId: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  // 🟢 НОВОЕ ПОЛЕ: ID выбранного товара для ожидания количества
  tempProductId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  
  currentOrder: [
    {
      product: String,
      quantity: Number,
      total: Number
    }
  ]
});

module.exports = mongoose.model('User', userSchema);