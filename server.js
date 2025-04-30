const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
const { OAuth2Client } = require('google-auth-library');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const oauthClient = new OAuth2Client('633871000162-dfmg4dqnkaooasaddmsjbmcm16aujjn5.apps.googleusercontent.com');

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

// ✅ Environment Variables
const MONGODB_URI = process.env.MONGODB_URI;
const INVENTORY_DB_URI = process.env.INVENTORY_DB_URI;
const EMPLOYEE_DB_URI = process.env.EMPLOYEE_DB_URI;
const port = process.env.PORT || 3000;

if (!MONGODB_URI || !INVENTORY_DB_URI || !EMPLOYEE_DB_URI) {
  console.error('❌ One or more MongoDB URIs are missing in environment variables!');
  process.exit(1);
}

// ✅ Database Connections
const db1 = mongoose.createConnection(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const inventoryConnection = mongoose.createConnection(INVENTORY_DB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
const employeeConnection = mongoose.createConnection(EMPLOYEE_DB_URI, { useNewUrlParser: true, useUnifiedTopology: true });

[db1, inventoryConnection, employeeConnection].forEach((db, i) => {
  db.on('connected', () => console.log(`✅ Connected to MongoDB database #${i + 1}`));
  db.on('error', (err) => console.error(`❌ MongoDB connection error #${i + 1}:`, err.message));
});

// ✅ Schemas
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
  createdAt: { type: Date, default: Date.now }
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
  price: Number,
  addedAt: { type: Date, default: Date.now }
});
const CardInventory = inventoryConnection.model('CardInventory', inventorySchema, 'Card Inventory');

const employeeSchema = new mongoose.Schema({
  role: { type: String, required: true },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  phone: { type: String, required: true },
  email: { type: String, required: true },
  emergencyContact: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});
const Employee = employeeConnection.model('Employee', employeeSchema, 'Employees');

// ✅ Routes
app.get('/', (req, res) => res.send('🧙‍♂️ Welcome to the Geega Games API!'));
app.get('/api/version-check', (req, res) => res.send('✅ Latest server.js version'));

// ✅ Creature Types
app.get('/api/inventory/creature-types', async (req, res) => {
  try {
    const types = await CardInventory.distinct('creatureTypes');
    res.json([...new Set(types.flat().filter(Boolean))].sort());
  } catch (err) {
    console.error('❌ Creature types error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Signup
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

// ✅ Google Login
app.post('/api/google-login', async (req, res) => {
  const { token } = req.body;

  try {
    const ticket = await oauthClient.verifyIdToken({
      idToken: token,
      audience: '633871000162-dfmg4dqnkaooasaddmsjbmcm16aujjn5.apps.googleusercontent.com'
    });

    const payload = ticket.getPayload();
    const { email, name, sub } = payload;

    let user = await User.findOne({ email });

    if (!user) {
      user = await new User({
        username: email.split('@')[0],
        email,
        firstName: name,
        lastName: '',
        password: await bcrypt.hash(sub, 10),
        phone: '',
        address: '',
        state: '',
        zip: ''
      }).save();
    }

    res.status(200).json({
      message: 'Google login successful',
      username: user.username,
      email: user.email
    });
  } catch (err) {
    console.error("Google login error:", err);
    res.status(401).json({ message: 'Invalid token' });
  }
});

// ✅ Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ message: 'Invalid credentials.' });

    res.json({ message: 'Login successful', userId: user._id, username: user.username });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Other Routes
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

app.get('/api/inventory', async (req, res) => {
  try {
    res.json(await CardInventory.find().sort({ cardName: 1 }));
  } catch (err) {
    console.error('❌ Fetch inventory error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

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

// ✅ Start Server
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
