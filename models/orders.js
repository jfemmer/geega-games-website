const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  userId: String,
  firstName: String,
  lastName: String,
  email: String,
  address: String,
  shippingMethod: String,
  paymentMethod: String,
  cards: [
    {
      cardName: String,
      set: String,
      foil: Boolean,
      specialArt: String,
      quantity: Number,
    }
  ],
  submittedAt: {
    type: Date,
    default: Date.now,
  }
});

module.exports = mongoose.model('Order', orderSchema);
