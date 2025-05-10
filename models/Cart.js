const mongoose = require('mongoose');

const itemSchema = new mongoose.Schema({
  cardName: String,
  set: String,
  foil: Boolean,
  variantType: String,
  condition: String,
  quantity: Number,
  priceUsd: Number,
  imageUrl: String  // ✅ Add this line
});

const CartSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  items: [itemSchema],
  updatedAt: { type: Date, default: Date.now }
});

// ✅ Export as a function to bind to a specific connection
module.exports = (connection) =>
  connection.model('Cart', CartSchema, 'Cart');
