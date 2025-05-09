// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const Cart = require('./models/Cart');

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());

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

// ✅ Connection Logs
[db1, inventoryConnection, employeeConnection, tradeInConnection].forEach((db, i) => {
  db.on('connected', () => console.log(`✅ Connected to MongoDB database #${i+1}`));
  db.on('error', (err) => console.error(`❌ MongoDB connection error #${i+1}:`, err.message));
});

// ✅ Schemas and Models
const userSchema = new mongoose.Schema({
  firstName: String, lastName: String, username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true }, password: { type: String, required: true },
  phone: String, address: String, state: String, zip: String, createdAt: { type: Date, default: Date.now }
});
const User = db1.model('User', userSchema);

const inventorySchema = new mongoose.Schema({
  cardName: { type: String, required: true }, quantity: { type: Number, required: true },
  set: { type: String, required: true }, condition: { type: String, required: true },
  foil: { type: Boolean, default: false }, imageUrl: String, colors: [String],
  cardType: String, creatureTypes: [String], price: Number, addedAt: { type: Date, default: Date.now }
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
      quantity: Number
    }
  ],
  submittedAt: { type: Date, default: Date.now }
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
app.get('/', (req, res) => res.send('🧙‍♂️ Welcome to the Geega Games API!'));
app.get('/api/version-check', (req, res) => res.send('✅ Latest server.js version'));

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
    const { firstName, lastName, username, email, password, phone, address, state, zip } = req.body;
    if (!username || !email || !password) return res.status(400).json({ message: 'Missing required fields.' });

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) return res.status(409).json({ message: 'User already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);
    await new User({ firstName, lastName, username, email, password: hashedPassword, phone, address, state, zip }).save();

    res.status(201).json({ message: '🐶 Welcome to the Pack!' });
  } catch (err) {
    console.error('❌ Signup error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(401).json({ message: 'Invalid credentials.' });

    res.json({ message: 'Login successful', userId: user._id, username: user.username, firstName: user.firstName });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.get('/api/users', async (req, res) => {
  try {
    res.json(await User.find().sort({ createdAt: -1 }));
  } catch (err) {
    console.error('❌ Fetch users error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

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

// Cart Routes
app.get('/api/cart', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    const cart = await Cart.findOne({ userId });
    res.json(cart || { items: [] });
  } catch (err) {
    console.error('❌ Cart fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart', async (req, res) => {
  const { userId, card } = req.body;
  if (!userId || !card) return res.status(400).json({ message: 'Missing data' });

  let cart = await Cart.findOne({ userId });
  if (!cart) cart = new Cart({ userId, items: [] });

  const key = `${card.cardName}|${card.set}|${card.foil}|${card.condition}`;
  const existing = cart.items.find(i => `${i.cardName}|${i.set}|${i.foil}|${i.condition}` === key);

  if (existing) existing.quantity += 1;
  else cart.items.push(card);

  cart.updatedAt = new Date();
  await cart.save();
  res.json(cart);
});

app.post('/api/cart/remove', async (req, res) => {
  const { userId, index } = req.body;
  if (!userId || typeof index !== 'number') return res.status(400).json({ error: 'Missing data' });

  try {
    const cart = await Cart.findOne({ userId });
    if (!cart || !cart.items || index >= cart.items.length) return res.status(404).json({ error: 'Item not found' });

    cart.items.splice(index, 1);
    cart.updatedAt = new Date();
    await cart.save();

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Remove from cart error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart/clear', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  try {
    await Cart.findOneAndUpdate({ userId }, { items: [], updatedAt: new Date() });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Cart clear error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Orders
app.post('/api/orders', async (req, res) => {
  const { userId, firstName, email, cards } = req.body;
  if (!userId || !cards || !Array.isArray(cards) || cards.length === 0) return res.status(400).json({ message: 'Invalid order data.' });

  try {
    await new Order({ userId, firstName, email, cards }).save();
    res.status(201).json({ message: 'Order submitted successfully!' });
  } catch (err) {
    console.error('❌ Order submission error:', err);
    res.status(500).json({ message: 'Internal server error.' });
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

// Start Server
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
