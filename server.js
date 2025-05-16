// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
console.log("Stripe key exists?", !!process.env.STRIPE_SECRET_KEY);

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();

// 🆕 NEW: Multer + Tesseract
const multer = require('multer');
const Tesseract = require('tesseract.js');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const uspsUserID = process.env.USPS_USER_ID;

// Setup for multer file uploads
const upload = multer({ dest: 'uploads/' });

// Email + Twilio
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.NOTIFY_EMAIL,
    pass: process.env.NOTIFY_PASSWORD,
  }
});

const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// Middleware
app.use(express.json());

app.use(cors({
  origin: ['http://localhost:5500', 'https://jfemmer.github.io', 'https://www.geega-games.com'],
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type'],
  credentials: true
}));


// ✅ Scryfall Image Fetch Helper
const fetchScryfallImageUrl = async (name, set, options = {}) => {
  const cleanedName = name.split('(')[0].trim();
  const loweredName = name.toLowerCase();
  let query = `${cleanedName} set:${set.toLowerCase()}`;

  if (loweredName.includes('borderless')) query += ' is:borderless';
  else if (loweredName.includes('showcase')) query += ' frame:showcase';
  else if (loweredName.includes('extended')) query += ' frame:extendedart';

  if (loweredName.includes('rainbow foil') || set.toLowerCase().startsWith('sl')) {
    query += ' finish:rainbow_foil';
  }

  try {
    const searchUrl = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`;
    const result = await axios.get(searchUrl);
    const cardData = result.data.data?.[0];
    if (!cardData) return '';
    return cardData.image_uris?.normal || cardData.card_faces?.[0]?.image_uris?.normal || '';
  } catch (err) {
    console.warn(`⚠️ Couldn’t fetch image for ${name} (${set}):`, err.message);
    return '';
  }
};

// ✅ Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const INVENTORY_DB_URI = process.env.INVENTORY_DB_URI;
const EMPLOYEE_DB_URI = process.env.EMPLOYEE_DB_URI;
const TRADEIN_DB_URI = process.env.TRADEIN_DB_URI;
const port = process.env.PORT || 3000;

if (!MONGODB_URI || !INVENTORY_DB_URI || !EMPLOYEE_DB_URI || !TRADEIN_DB_URI ) {
  console.error('❌ One or more MongoDB URIs are missing in environment variables!');
  process.exit(1);
}

// ✅ Connect to MongoDB
const db1 = mongoose.createConnection(MONGODB_URI);
const inventoryConnection = mongoose.createConnection(INVENTORY_DB_URI);
const employeeConnection = mongoose.createConnection(EMPLOYEE_DB_URI);
const tradeInConnection = mongoose.createConnection(TRADEIN_DB_URI);

const createCartModel = require('./models/Cart');
const Cart = createCartModel(db1);


// ✅ Connection Logs
[db1, inventoryConnection, employeeConnection, tradeInConnection].forEach((db, i) => {
  db.on('connected', () => console.log(`✅ Connected to MongoDB database #${i+1}`));
  db.on('error', (err) => console.error(`❌ MongoDB connection error #${i+1}:`, err.message));
});

const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: String,
  address: String,
  state: String,
  zip: String,
  createdAt: { type: Date, default: Date.now },

  // ✅ Notification Preferences
  announcementNotifications: {
  enabled: { type: Boolean, default: false },
  byEmail: { type: Boolean, default: true },
  byText: { type: Boolean, default: false }
},

  shippingNotifications: {
    enabled: { type: Boolean, default: true },
    byEmail: { type: Boolean, default: true },
    byText: { type: Boolean, default: false }
  }
});

const User = db1.model('User', userSchema);

const inventorySchema = new mongoose.Schema({
  cardName: { type: String, required: true },
  quantity: { type: Number, required: true },
  set: { type: String, required: true },
  condition: { type: String, required: true },
  foil: { type: Boolean, default: false },
  imageUrl: String,
  colors: [String],
  cardType: String,
  creatureTypes: [String],
  priceUsd: Number,         // ✅ add this
  priceUsdFoil: Number,     // ✅ and this
  addedAt: { type: Date, default: Date.now }
});
const CardInventory = inventoryConnection.model('CardInventory', inventorySchema, 'Card Inventory');

const employeeSchema = new mongoose.Schema({
  role: { type: String, required: true }, firstName: { type: String, required: true },
  lastName: { type: String, required: true }, phone: { type: String, required: true },
  email: { type: String, required: true }, emergencyContact: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Employee = employeeConnection.model('Employee', employeeSchema, 'Employees');

const orderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  firstName: String,
  lastName: String,
  email: String,
  address: String,
  cards: [
    {
      cardName: String,
      set: String,
      foil: Boolean,
      specialArt: String,
      quantity: Number,
      imageUrl: String,
      priceUsd: Number,
      condition: String
    }
  ],
  shippingMethod: String,
  paymentMethod: String,
  orderTotal: Number,
  submittedAt: { type: Date, default: Date.now },

  // 🆕 Status + Tracking Fields
  status: { type: String, default: 'Pending' }, // e.g. 'Packing', 'Dropped Off', 'Shipped'
  packedAt: Date,
  droppedOffAt: Date, // ✅ Add this line
  trackingNumber: String,
  trackingCarrier: String, // e.g., 'USPS', 'UPS'
  trackingHistory: [
    {
      timestamp: Date,
      status: String,
      details: String
    }
  ]
});

const Order = db1.model('Order', orderSchema, 'Orders');

const tradeInSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  firstName: String,
  lastName: String,
  email: String,
  phone: String,
  cards: [
    {
      cardName: String,
      set: String,
      foil: Boolean,
      condition: String,
      imageUrl: String,
    },
  ],
  submittedAt: { type: Date, default: Date.now }
});

const TradeIn = tradeInConnection.model('TradeIn', tradeInSchema, 'TradeIns');

// ✅ Routes

// Root
app.get('/', (req, res) => res.send('🧙‍♂️ Welcome to the Geega Games API!'));

// Version Check
app.get('/api/version-check', (req, res) => res.send('✅ Latest server.js version'));


// 🔁 Get cart
// ✅ GET cart
// ✅ GET cart
// ✅ GET cart
// 🛒 GET cart
app.get('/api/cart', async (req, res) => {
  const { userId } = req.query;
  console.log('📥 [GET] /api/cart - Received userId:', userId);

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (GET):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    console.log('🔍 Converted userId to ObjectId:', objectId);

    const cart = await Cart.findOne({ userId: objectId });
    console.log('📦 Cart query result:', cart);

    res.json(cart ? { items: cart.items || [] } : { items: [] });
  } catch (err) {
    console.error('❌ [GET] Fetch cart error:', err.stack || err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// 🛒 POST add item to cart
app.post('/api/cart', async (req, res) => {
  const { userId, item } = req.body;
  console.log('📥 [POST] /api/cart - Payload:', { userId, item });

  // 🔍 Validate userId
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (POST):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  // 🔍 Validate item fields
  if (!item || !item.cardName || !item.set || !item.condition || item.quantity == null) {
    console.warn('⚠️ Missing required item fields:', item);
    return res.status(400).json({ message: 'Missing required item fields (cardName, set, condition, quantity).' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);

    // 🔍 Lookup matching inventory item
    const inventoryItem = await CardInventory.findOne({
      cardName: item.cardName,
      set: item.set,
      foil: !!item.foil,
      condition: item.condition
    });

    if (!inventoryItem) {
      console.warn('⚠️ Inventory item not found:', item);
      return res.status(404).json({ message: 'Item not found in inventory.' });
    }

    if (inventoryItem.quantity < item.quantity) {
      console.warn(`⚠️ Not enough stock. Requested: ${item.quantity}, Available: ${inventoryItem.quantity}`);
      return res.status(400).json({ message: 'Not enough inventory to add to cart.' });
    }

    let cart = await Cart.findOne({ userId: objectId });
    console.log('🛒 Existing cart:', cart || 'None found');

    if (!cart) {
      console.log('➕ Creating new cart');
      cart = new Cart({ userId: objectId, items: [item] });
    } else {
      const key = `${item.cardName}|${item.set}|${item.foil}|${item.condition}|${item.variantType}`;
      const existing = cart.items.find(i =>
        `${i.cardName}|${i.set}|${i.foil}|${i.condition}|${i.variantType}` === key
      );

      const currentQty = existing ? existing.quantity : 0;
      const newTotalQty = currentQty + item.quantity;

      if (newTotalQty > inventoryItem.quantity) {
        console.warn(`⚠️ Combined quantity (${newTotalQty}) exceeds stock (${inventoryItem.quantity})`);
        return res.status(400).json({ message: 'You cannot add more than what is in stock.' });
      }

      if (existing) {
        console.log('🧩 Updating quantity of existing item in cart');
        existing.quantity = newTotalQty;
      } else {
        console.log('🆕 Pushing new item to cart');
        cart.items.push(item);
      }
    }

    cart.updatedAt = new Date();
    await cart.save();
    console.log('✅ Cart saved successfully');
    res.status(200).json({ message: 'Item added to cart' });
  } catch (err) {
    console.error('❌ [POST] Add to cart error:', err.stack || err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

app.post('/create-payment-intent', async (req, res) => {
  const { amount } = req.body;

  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // convert dollars to cents
      currency: 'usd',
      payment_method_types: ['card'],
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('❌ Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});


// 🗑️ POST remove item by index
app.post('/api/cart/remove', async (req, res) => {
  const { userId, index, quantity = 1 } = req.body;
  console.log('📥 [POST] /api/cart/remove - userId:', userId, 'index:', index, 'quantity:', quantity);

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (REMOVE):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    const cart = await Cart.findOne({ userId: objectId });

    if (!cart) {
      console.warn('⚠️ No cart found for userId:', userId);
      return res.status(404).json({ message: 'Cart not found.' });
    }

    if (index < 0 || index >= cart.items.length) {
      console.warn('⚠️ Index out of bounds:', index);
      return res.status(400).json({ message: 'Invalid index.' });
    }

    const item = cart.items[index];

    if (!item.quantity || typeof item.quantity !== 'number') {
      console.warn('⚠️ Invalid item quantity:', item.quantity);
      return res.status(400).json({ message: 'Invalid item quantity.' });
    }

    if (item.quantity > quantity) {
      console.log(`➖ Decreasing quantity of "${item.cardName}" from ${item.quantity} by ${quantity}`);
      cart.items[index].quantity -= quantity;
    } else {
      console.log(`🗑️ Removing entire item "${item.cardName}" from cart (quantity ${item.quantity})`);
      cart.items.splice(index, 1);
    }

    cart.updatedAt = new Date();
    await cart.save();

    res.status(200).json({ message: 'Item updated in cart' });
  } catch (err) {
    console.error('❌ [REMOVE] Error:', err.stack || err);
    res.status(500).json({ message: 'Internal server error' });
  }
});


// 🧹 POST clear cart
app.post('/api/cart/clear', async (req, res) => {
  const { userId } = req.body;
  console.log('📥 [POST] /api/cart/clear - userId:', userId);

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (CLEAR):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    const result = await Cart.findOneAndUpdate(
      { userId: objectId },
      { items: [], updatedAt: new Date() }
    );

    console.log('🧹 Cart clear result:', result);
    res.status(200).json({ message: 'Cart cleared' });
  } catch (err) {
    console.error('❌ [CLEAR] Cart error:', err.stack || err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Creature Types
app.get('/api/inventory/creature-types', async (req, res) => {
  try {
    const types = await CardInventory.distinct('creatureTypes');
    res.json([...new Set(types.flat().filter(Boolean))].sort());
  } catch (err) {
    console.error('❌ Creature types error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


app.post('/signup', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      username,
      email,
      password,
      phone,
      address,
      state,
      zip,
      announcementNotifications,
      shippingNotifications
    } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(409).json({ message: 'User already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);

    await new User({
      firstName,
      lastName,
      username,
      email,
      password: hashedPassword,
      phone,
      address,
      state,
      zip,
      announcementNotifications: {
        enabled: announcementNotifications?.enabled ?? false,
        byEmail: announcementNotifications?.byEmail ?? true,
        byText: announcementNotifications?.byText ?? false
      },
      shippingNotifications: {
        enabled: shippingNotifications?.enabled ?? true,
        byEmail: shippingNotifications?.byEmail ?? true,
        byText: shippingNotifications?.byText ?? false
      }
    }).save();

    res.status(201).json({ message: '🐶 Welcome to the Pack!' });
  } catch (err) {
    console.error('❌ Signup error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    res.json({
      message: 'Login successful',
      userId: user._id,
      username: user.username,
      firstName: user.firstName  // ✅ make sure this is here
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Get All Users
app.get('/api/users', async (req, res) => {
  try {
    res.json(await User.find().sort({ createdAt: -1 }));
  } catch (err) {
    console.error('❌ Fetch users error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// PATCH /api/users/:id - Update address info
app.patch('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { address, state, zip } = req.body;

    const updated = await User.findByIdAndUpdate(
      id,
      { address, state, zip },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'User not found.' });

    res.json({ message: 'User updated.', user: updated });
  } catch (err) {
    console.error('❌ Failed to update user:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Add Inventory Card
app.post('/api/inventory', async (req, res) => {
  try {
    const { cardName, quantity, set, condition, foil, price } = req.body;
    if (!cardName || !quantity || !set || !condition) return res.status(400).json({ message: 'Missing fields.' });

    const imageUrl = req.body.imageUrl?.trim() || await fetchScryfallImageUrl(cardName, set);
    await new CardInventory({ cardName, quantity, set, condition, foil: !!foil, imageUrl, price }).save();

    res.status(201).json({ message: 'Card added to inventory!' });
  } catch (err) {
    console.error('❌ Add inventory error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.post('/api/tradein', async (req, res) => {
  const { userId, cards } = req.body;

  if (!userId || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ message: 'Invalid trade-in data.' });
  }

  try {
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const tradeInData = {
      userId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      cards
    };

    await new TradeIn(tradeInData).save();
    res.status(201).json({ message: '🧾 Trade-in submitted successfully!' });
  } catch (err) {
    console.error('❌ Trade-in submission error:', err);
    res.status(500).json({ message: 'Server error while submitting trade-in.' });
  }
});


app.get('/api/inventory', async (req, res) => {
  try {
    const cards = await CardInventory.find({}, {
      cardName: 1,
      quantity: 1,
      set: 1,
      condition: 1,
      foil: 1,
      imageUrl: 1,
      colors: 1,
      cardType: 1,
      creatureTypes: 1,
      priceUsd: 1,
      priceUsdFoil: 1,
      addedAt: 1
    }).sort({ cardName: 1 });

    res.json(cards);
  } catch (err) {
    console.error('❌ Fetch inventory error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Get Single Price
app.post('/api/inventory/price', async (req, res) => {
  const { cardName, set, foil } = req.body;
  try {
    const card = await CardInventory.findOne({ cardName, set, foil: !!foil });
    if (!card || card.price == null) return res.status(404).json({ error: 'Price not found' });
    res.json({ price: card.price });
  } catch (err) {
    console.error('❌ Single price error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/inventory/update-price', async (req, res) => {
  const { cardName, set, foil, newPrice } = req.body;
  if (!cardName || !set || typeof newPrice !== 'number') {
    return res.status(400).json({ message: 'Missing required fields.' });
  }

  try {
    const fieldToUpdate = foil ? 'priceUsdFoil' : 'priceUsd';

    const updated = await CardInventory.findOneAndUpdate(
      { cardName, set, foil },
      { [fieldToUpdate]: newPrice },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'Card not found.' });

    res.json({ message: 'Price updated.', updated });
  } catch (err) {
    console.error('❌ Update price error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});


app.post('/api/inventory/prices', async (req, res) => {
  try {
    const { cards } = req.body;
    if (!Array.isArray(cards)) return res.status(400).json({ error: 'Cards array required.' });

    const prices = {};
    const normalize = str => str?.toLowerCase().trim().replace(/\s+/g, ' ') || '';

    for (const { cardName, set, foil } of cards) {
      if (!cardName || !set) continue;

      // Try exact match
      let match = await CardInventory.findOne({ cardName, set, foil: !!foil });

      // Try case-insensitive fallback
      if (!match) {
        match = await CardInventory.findOne({
          cardName: { $regex: `^${cardName}$`, $options: 'i' },
          set: { $regex: `^${set}$`, $options: 'i' },
          foil: !!foil
        });
      }

      if (match) {
        const key = `${normalize(cardName)}|${normalize(set)}|${foil ? '1' : '0'}`;
        let rawPrice = foil ? match.priceUsdFoil : match.priceUsd;
        if (rawPrice == null && match.price != null) {
          rawPrice = match.price;  // ✅ fallback to general price
        }
        prices[key] = parseFloat(rawPrice) || 0;
      }
    }

    res.json(prices);
  } catch (err) {
    console.error('❌ Batch prices error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/orders', async (req, res) => {
  console.log('🧾 Incoming order data:', req.body);

  const {
    userId,
    firstName,
    lastName,
    email,
    address,
    cards,
    shippingMethod,
    paymentMethod,
    orderTotal
  } = req.body;

  try {
    const parsedOrderTotal = parseFloat(orderTotal);
    const newOrder = new Order({
      userId,
      firstName,
      lastName,
      email,
      address,
      cards,
      shippingMethod,
      paymentMethod,
      orderTotal: isNaN(parsedOrderTotal) ? 0 : parsedOrderTotal,
      status: req.body.status || 'Pending'  // ✅ this line ensures status gets saved
    });

    const savedOrder = await newOrder.save();
    res.status(201).json(savedOrder);
  } catch (err) {
    console.error('❌ Error saving order:', err);
    res.status(500).json({ message: 'Server error while saving order.' });
  }
});

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ submittedAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error('❌ Fetch orders error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Delete Inventory Card
app.delete('/api/inventory', async (req, res) => {
  try {
    const { cardName, set, foil } = req.body;
    const deleted = await CardInventory.findOneAndDelete({ cardName, set, foil: !!foil });
    if (!deleted) return res.status(404).json({ message: 'Card not found.' });
    res.status(200).json({ message: 'Card deleted successfully.' });
  } catch (err) {
    console.error('❌ Delete card error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.patch('/api/inventory/decrement', async (req, res) => {
  try {
    const { cardName, set, foil } = req.body;

    const card = await CardInventory.findOne({ cardName, set, foil: !!foil });

    if (!card) {
      return res.status(404).json({ message: 'Card not found.' });
    }

    if (card.quantity > 1) {
      card.quantity -= 1;
      await card.save();
      return res.status(200).json({ message: 'Quantity decremented.' });
    } else {
      await CardInventory.deleteOne({ _id: card._id });
      return res.status(200).json({ message: 'Card removed from inventory (quantity reached 0).' });
    }
  } catch (err) {
    console.error('❌ Decrement card error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Add Employee
app.post('/api/employees', async (req, res) => {
  const { role, firstName, lastName, phone, email, emergencyContact } = req.body;
  try {
    await new Employee({ role, firstName, lastName, phone, email, emergencyContact }).save();
    res.status(201).json({ message: 'Employee added!' });
  } catch (err) {
    console.error('❌ Employee error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});


app.patch('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, trackingNumber } = req.body;

  try {
    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (status) {
  order.status = status;

  if (status.toLowerCase() === 'packing') {
    order.packedAt = new Date();
  }

  if (status.toLowerCase() === 'dropped off') {
    order.droppedOffAt = new Date(); // ✅ Save current time
  }
}
    if (trackingNumber) order.trackingNumber = trackingNumber;
    await order.save();

    const user = await User.findById(order.userId);
    if (!user) {
      console.warn('⚠️ User not found for order.userId:', order.userId);
      return res.json({ message: 'Order updated, but user not found.' });
    }

    if (user?.shippingNotifications?.enabled) {
      const message = `📦 Your Geega Games order is now: ${status}` +
        (trackingNumber ? ` (Tracking #: ${trackingNumber})` : '');

      try {
        // ✅ Email
        if (user.shippingNotifications.byEmail && user.email) {
          console.log('📧 Sending email to', user.email);
          await transporter.sendMail({
            from: `"Geega Games" <${process.env.NOTIFY_EMAIL}>`,
            to: user.email,
            subject: '🧙 Order Status Update',
            text: message
          });
        }

        // ✅ SMS
        if (user.shippingNotifications.byText && user.phone) {
          const formattedPhone = user.phone.startsWith('+') ? user.phone : `+1${user.phone}`;
          console.log('📱 Sending SMS to', formattedPhone);
          await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE,
            to: formattedPhone
          });
        }
      } catch (notifyErr) {
        console.error('❌ Notification error:', notifyErr.message);
        // Optionally log notifyErr.stack if needed
      }
    }

    res.json({ message: 'Order updated and notification (if enabled) sent.', order });
  } catch (err) {
    console.error('❌ Order update error:', err.stack || err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/upload-card-image', upload.single('cardImage'), async (req, res) => {
  const imagePath = path.resolve(req.file.path);

  async function sliceIntoCards(filePath) {
    const image = sharp(filePath);
    const { width, height } = await image.metadata();
    console.log(`📏 Image size: ${width} x ${height}`);

    if (!width || !height || width < 900 || height < 900) {
      throw new Error(`Image too small to slice: ${width}x${height} (min: 900x900 for 3x3 binder layout)`);
    }

    const cols = 3;
    const rows = 3;
    const cardWidth = Math.floor(width / cols);
    const cardHeight = Math.floor(height / rows);

    const cardPaths = [];

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * cardWidth;
        const top = row * cardHeight;
        const cropWidth = (col === cols - 1) ? width - left : cardWidth;
        const cropHeight = (row === rows - 1) ? height - top : cardHeight;

        const outputPath = `${filePath}-slice-${row}-${col}.png`;

        try {
          await image
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .toFile(outputPath);

          cardPaths.push(outputPath);
        } catch (err) {
          console.warn(`⚠️ Skipped invalid slice (${row},${col}): ${err.message}`);
        }
      }
    }

    return cardPaths;
  }

  try {
    const slicedPaths = await sliceIntoCards(imagePath);
    const results = [];

    for (const slice of slicedPaths) {
      try {
        console.log(`🔍 OCR on: ${slice}`);
        const { data: { text } } = await Tesseract.recognize(slice, 'eng');
        console.log(`🧠 OCR text:\n${text}`);

        const lines = text
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length >= 2);

        for (const line of lines) {
          try {
            console.log(`🔗 Trying Scryfall for: "${line}"`);
            const response = await axios.get(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(line)}`);
            const card = response.data;

            results.push({
              input: line,
              matchedCard: card.name,
              set: card.set_name,
              image: card.image_uris?.normal || '',
              price: card.prices.usd || 'N/A',
            });
            break; // stop after first valid match per slice
          } catch (err) {
            console.warn(`❌ No match on Scryfall for "${line}"`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ OCR or parsing failed on ${slice}: ${err.message}`);
      } finally {
        if (fs.existsSync(slice)) fs.unlinkSync(slice);
      }
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'No cards recognized. Try a clearer photo of your binder page.' });
    }

    res.json({ count: results.length, cards: results });
  } catch (err) {
    console.error('❌ Full processing error:', err.message || err);
    res.status(500).json({ error: 'Could not process image or fetch card data.' });
  } finally {
    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
  }
});

app.get('/api/track-usps/:trackingNumber', async (req, res) => {
  const { trackingNumber } = req.params;
  const uspsUserID = process.env.USPS_USER_ID;

  const xml = `
    <TrackFieldRequest USERID="${uspsUserID}">
      <TrackID ID="${trackingNumber}"></TrackID>
    </TrackFieldRequest>
  `.trim();

  try {
    const uspsRes = await axios.get('https://secure.shippingapis.com/ShippingAPI.dll', {
      params: {
        API: 'TrackV2',
        XML: xml,
      },
    });

    const body = uspsRes.data;
    console.log('📨 Raw USPS XML:', body); // ✅ Add this log

    let statusText = '';
    let dateText = '';

    const summaryMatch = body.match(/<TrackSummary>(.*?)<\/TrackSummary>/);
    if (summaryMatch) {
      statusText = summaryMatch[1];
    } else {
      const detailMatch = body.match(/<TrackDetail>(.*?)<\/TrackDetail>/);
      if (detailMatch) {
        statusText = detailMatch[1];
      }
    }

    if (statusText) {
      const dateMatch = statusText.match(/on (.*?)\./i);
      dateText = dateMatch ? dateMatch[1] : 'N/A';

      return res.json({
        status: statusText.split(',')[0],
        date: dateText,
      });
    }

    res.json({ status: 'Tracking info not yet available', date: 'N/A' });
  } catch (err) {
    console.error('❌ USPS tracking error:', err.message || err);
    res.status(500).json({ status: 'Error', date: '' });
  }
});






// Start Server
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
