// ✨ Updated server.js with /api/prices endpoint for real-time price lookups
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const INVENTORY_DB_URI = process.env.INVENTORY_DB_URI;
const EMPLOYEE_DB_URI = process.env.EMPLOYEE_DB_URI;
const port = process.env.PORT || 3000;

if (!MONGODB_URI || !INVENTORY_DB_URI || !EMPLOYEE_DB_URI) {
  console.error('❌ One or more MongoDB URIs are missing in environment variables!');
  process.exit(1);
}

// ✅ DB Connections
const db1 = mongoose.createConnection(MONGODB_URI);
const inventoryConnection = mongoose.createConnection(INVENTORY_DB_URI);
const employeeConnection = mongoose.createConnection(EMPLOYEE_DB_URI);

// ✅ Schemas
const userSchema = new mongoose.Schema({
  firstName: String,
  lastName: String,
  username: { type: String, required: true, unique: true },
  email:    { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone:    String,
  address:  String,
  state:    String,
  zip:      String,
  createdAt: { type: Date, default: Date.now }
});
const User = db1.model('User', userSchema);

const inventorySchema = new mongoose.Schema({
  cardName: String,
  quantity: Number,
  set: String,
  condition: String,
  foil: Boolean,
  imageUrl: String,
  colors: [String],
  cardType: String,
  creatureTypes: [String],
  addedAt: { type: Date, default: Date.now },
  price: String,
  foilPrice: String
});
const CardInventory = inventoryConnection.model('CardInventory', inventorySchema, 'Card Inventory');

const employeeSchema = new mongoose.Schema({
  role: String,
  firstName: String,
  lastName: String,
  phone: String,
  email: String,
  emergencyContact: String,
  createdAt: { type: Date, default: Date.now }
});
const Employee = employeeConnection.model('Employee', employeeSchema, 'Employees');

// ✅ Routes
app.get('/', (req, res) => {
  res.send('🧙‍♂️ Welcome to the Geega Games API!');
});

app.post('/signup', async (req, res) => {
  const { firstName, lastName, username, email, password, phone, address, state, zip } = req.body;
  if (!username || !email || !password) return res.status(400).json({ message: 'Missing fields' });

  const existing = await User.findOne({ $or: [{ email }, { username }] });
  if (existing) return res.status(409).json({ message: 'User already exists' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = new User({ firstName, lastName, username, email, password: hashedPassword, phone, address, state, zip });
  await user.save();
  res.status(201).json({ message: '✅ User created' });
});

app.get('/api/inventory', async (req, res) => {
  try {
    const cards = await CardInventory.find().sort({ cardName: 1 });
    res.json(cards);
  } catch (err) {
    res.status(500).json({ message: '❌ Could not load inventory' });
  }
});

app.get('/api/inventory/creature-types', async (req, res) => {
  try {
    const types = await CardInventory.distinct('creatureTypes');
    const flattened = [...new Set(types.flat().filter(Boolean))];
    res.json(flattened.sort());
  } catch (err) {
    console.error('Failed to fetch creature types', err);
    res.status(500).json({ error: 'Failed to fetch creature types' });
  }
});

// ✅ Real-time Scryfall Price Endpoint
app.get('/api/prices', async (req, res) => {
  const { name, set, foil } = req.query;
  if (!name || !set) return res.status(400).json({ error: 'Missing name or set' });

  try {
    const query = `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}&set=${set.toLowerCase()}`;
    const response = await axios.get(query);
    const price = foil === 'true' ? response.data.prices.usd_foil : response.data.prices.usd;
    res.json({ price });
  } catch (err) {
    console.error('❌ Price fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

// ✅ Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
