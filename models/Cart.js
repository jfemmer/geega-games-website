const mongoose = require('mongoose');

const CartItemSchema = new mongoose.Schema({
  cardName: String,
  set: String,
  foil: Boolean,
  variantType: String,
  condition: String,
  quantity: Number,
  priceUsd: String // You can switch to Number later if needed
});

const CartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  items: [CartItemSchema],
  updatedAt: { type: Date, default: Date.now }
});

// ✅ Export as a function to bind to a specific connection
module.exports = (connection) =>
  connection.model('Cart', CartSchema, 'Cart');
