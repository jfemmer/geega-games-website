const mongoose = require('mongoose');

const CartItemSchema = new mongoose.Schema({
  cardName: String,
  set: String,
  foil: Boolean,
  variantType: String,
  condition: String,
  quantity: Number,
  priceUsd: String, // or Number, but OK for now
});

const CartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  items: [CartItemSchema],
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Cart', CartSchema);
