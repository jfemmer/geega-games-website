// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'supersecretkey';

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Auth Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'Missing token' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ message: 'Invalid token' });
    req.user = user;
    next();
  });
}

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
const port = process.env.PORT || 3000;

if (!MONGODB_URI || !INVENTORY_DB_URI || !EMPLOYEE_DB_URI) {
  console.error('❌ One or more MongoDB URIs are missing in environment variables!');
  process.exit(1);
}

// ✅ Connect to MongoDB
const db1 = mongoose.createConnection(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const inventoryConnection = mongoose.createConnection(INVENTORY_DB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const employeeConnection = mongoose.createConnection(EMPLOYEE_DB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

// ✅ Connection Logs
[db1, inventoryConnection, employeeConnection].forEach((db, i) => {
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

// ✅ Routes

// Root
app.get('/', (req, res) => res.send('🧙‍♂️ Welcome to the Geega Games API!'));

// Version Check
app.get('/api/version-check', (req, res) => res.send('✅ Latest server.js version'));

// Protected User Info
app.get('/api/protected', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ message: `Hello, ${user.firstName}` });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
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

// Signup
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

// Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: 'Invalid credentials.' });

    const token = jwt.sign(
      { userId: user._id, username: user.username, email: user.email },
      JWT_SECRET,
      { expiresIn: '2h' }
    );

    res.json({ message: 'Login successful', token });
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

// Get All Inventory
app.get('/api/inventory', async (req, res) => {
  try {
    res.json(await CardInventory.find().sort({ cardName: 1 }));
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

// ✅ NEW: Batch Fetch Prices
app.post('/api/inventory/prices', async (req, res) => {
  try {
    const { cards } = req.body;
    if (!Array.isArray(cards)) return res.status(400).json({ error: 'Cards array required.' });

    const prices = {};
    for (const { cardName, set, foil } of cards) {
      if (!cardName || !set) continue;
      const match = await CardInventory.findOne({ cardName, set, foil: !!foil });
      if (match && match.price != null) prices[`${cardName}|${set}|${foil ? '1' : '0'}`] = match.price;
    }

    res.json(prices);
  } catch (err) {
    console.error('❌ Batch prices error:', err);
    res.status(500).json({ error: 'Server error' });
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



// Start Server
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
