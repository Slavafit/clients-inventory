const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  timestamp: { type: Date, default: Date.now },
  items: [
    {
      product: String,
      quantity: Number,
      price: Number
    }
  ],
  total: Number
});

module.exports = mongoose.model('Order', orderSchema);
