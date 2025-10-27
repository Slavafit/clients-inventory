const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  telegramId: { type: Number, required: true, unique: true },
  phone: { type: String },
  currentStep: { type: String, default: 'idle' },
  currentOrder: [
    {
      product: String,
      quantity: Number,
      price: Number
    }
  ]
});

module.exports = mongoose.model('User', userSchema);
