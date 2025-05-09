const mongoose = require('mongoose');

const CartItemSchema = new mongoose.Schema({
  cardName: String,
  set: String,
  foil: Boolean,
  variantType: String,
  condition: String,
  quantity: Number,
  priceUsd: String,
});

const CartSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  items: [CartItemSchema],
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Cart', CartSchema);
