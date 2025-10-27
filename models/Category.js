const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true },
  emoji: { type: String, default: '' }
});

module.exports = mongoose.model('Category', categorySchema);
