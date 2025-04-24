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

// ✅ Connect to MongoDB Atlas - Users
db1 = mongoose.createConnection(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
db1.on('connected', () => console.log('✅ Connected to MongoDB Atlas (geegaUsers)'));
db1.on('error', (err) => console.error('❌ MongoDB connection error (Users):', err.message));

// ✅ Second Connection for Inventory DB
const inventoryConnection = mongoose.createConnection(INVENTORY_DB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
inventoryConnection.on('connected', () => {
  console.log('✅ Connected to MongoDB Atlas (geegaInventory)');
});
inventoryConnection.on('error', (err) => {
  console.error('❌ Inventory DB connection error:', err.message);
});

// ✅ Third Connection for Employee DB
const employeeConnection = mongoose.createConnection(EMPLOYEE_DB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});
employeeConnection.on('connected', () => {
  console.log('✅ Connected to MongoDB Atlas (geegaEmployee)');
});
employeeConnection.on('error', (err) => {
  console.error('❌ Employee DB connection error:', err.message);
});

// ✅ User Schema & Model
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

// ✅ Inventory Schema & Model (Card Inventory)
const inventorySchema = new mongoose.Schema({
  cardName: { type: String, required: true },
  quantity: { type: Number, required: true },
  set: { type: String, required: true },
  condition: { type: String, required: true },
  foil: { type: Boolean, default: false },
  imageUrl: { type: String },
  colors: [String],
  cardType: String,
  creatureTypes: [String],
  price: Number,
  addedAt: { type: Date, default: Date.now }
});
const CardInventory = inventoryConnection.model('CardInventory', inventorySchema, 'Card Inventory');

// ✅ Employee Schema & Model
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

// ✅ Root Test Route
app.get('/', (req, res) => {
  res.send('🧙‍♂️ Welcome to the Geega Games API!');
});

app.get('/api/version-check', (req, res) => {
  res.send('✅ This is the latest version of the server.js file!');
});

// ✅ Creature Types Endpoint
app.get('/api/inventory/creature-types', async (req, res) => {
  try {
    const types = await CardInventory.distinct('creatureTypes');
    const flat = [...new Set(types.flat().filter(Boolean))];
    res.json(flat.sort());
  } catch (err) {
    console.error('❌ Creature type route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Signup Route
app.post('/signup', async (req, res) => {
  try {
    const {
      firstName, lastName, username, email, password,
      phone, address, state, zip
    } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Username, email, and password are required.' });
    }

    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(409).json({ message: 'User already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      firstName,
      lastName,
      username,
      email,
      password: hashedPassword,
      phone,
      address,
      state,
      zip
    });

    await user.save();
    res.status(201).json({ message: '🐶 Welcome to the Pack! 🐶' });
  } catch (err) {
    console.error('❌ Signup error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Login Route
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(401).json({ message: 'User not found.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid password.' });

    res.json({
      message: 'Login successful',
      userId: user._id,
      username: user.username
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Get All Users
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json(users);
  } catch (err) {
    console.error('❌ Error fetching users:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Add Inventory Card
app.post('/api/inventory', async (req, res) => {
  try {
    const { cardName, quantity, set, condition, foil, price } = req.body;

    if (!cardName || !quantity || !set || !condition) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    const imageUrl = req.body.imageUrl?.trim() || await fetchScryfallImageUrl(cardName, set);

    const card = new CardInventory({
      cardName,
      quantity,
      set,
      condition,
      foil: !!foil,
      imageUrl,
      price
    });

    await card.save();
    console.log(`✅ Saved ${cardName} (${set}) to inventory with image.`);
    res.status(201).json({ message: 'Card added to inventory!', card });
  } catch (err) {
    console.error('❌ Error adding card to inventory:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Get All Inventory Cards
app.get('/api/inventory', async (req, res) => {
  try {
    const cards = await CardInventory.find().sort({ cardName: 1 });
    res.json(cards);
  } catch (err) {
    console.error('❌ Error fetching inventory:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Get Card Price by Name/Set/Foil
app.post('/api/inventory/price', async (req, res) => {
  const { cardName, set, foil } = req.body;

  if (!cardName || !set) {
    return res.status(400).json({ error: 'Missing cardName or set' });
  }

  try {
    const match = await CardInventory.findOne({
      cardName,
      set,
      foil: !!foil
    });

    if (!match || !match.price) {
      return res.status(404).json({ error: 'Price not found' });
    }

    res.json({ price: match.price });
  } catch (err) {
    console.error('❌ Price route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ✅ Delete Inventory Card
app.delete('/api/inventory', async (req, res) => {
  try {
    const { cardName, set } = req.body;
    if (!cardName || !set) {
      return res.status(400).json({ message: 'Card name and set are required.' });
    }

    const deleted = await CardInventory.findOneAndDelete({ cardName, set });
    if (!deleted) {
      return res.status(404).json({ message: 'Card not found in inventory.' });
    }

    res.status(200).json({ message: 'Card deleted successfully.' });
  } catch (err) {
    console.error('❌ Delete card error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Add Employee
app.post('/api/employees', async (req, res) => {
  const { role, firstName, lastName, phone, email, emergencyContact } = req.body;

  if (!role || !firstName || !lastName || !phone || !email || !emergencyContact) {
    return res.status(400).json({ message: 'Missing required fields.' });
  }

  try {
    const employee = new Employee({ role, firstName, lastName, phone, email, emergencyContact });
    await employee.save();
    res.status(201).json({ message: 'Employee added!' });
  } catch (err) {
    console.error('❌ Failed to save employee:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
