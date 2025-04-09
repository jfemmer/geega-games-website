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

  // Handle style modifiers
  if (loweredName.includes('borderless')) query += ' is:borderless';
  else if (loweredName.includes('showcase')) query += ' frame:showcase';
  else if (loweredName.includes('extended')) query += ' frame:extendedart';

  // Handle secret lair/rainbow foil
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
const port = process.env.PORT || 3000;

if (!MONGODB_URI || !INVENTORY_DB_URI) {
  console.error('❌ One or more MongoDB URIs are missing in environment variables!');
  process.exit(1);
}

// ✅ Connect to MongoDB Atlas - Users
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB Atlas (geegaUsers)'))
.catch((err) => {
  console.error('❌ MongoDB connection error:', err.message);
  process.exit(1);
});

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

const User = mongoose.model('User', userSchema);

// ✅ Inventory Schema & Model (Card Inventory)
const inventorySchema = new mongoose.Schema({
  cardName: { type: String, required: true },
  quantity: { type: Number, required: true },
  set: { type: String, required: true },
  condition: { type: String, required: true },
  foil: { type: Boolean, default: false },
  imageUrl: { type: String },
  addedAt: { type: Date, default: Date.now }
});

const CardInventory = inventoryConnection.model('CardInventory', inventorySchema, 'Card Inventory');

// ✅ Root Test Route
app.get('/', (req, res) => {
  res.send('🧙‍♂️ Welcome to the Geega Games API!');
});

app.get('/api/version-check', (req, res) => {
  res.send('✅ This is the latest version of the server.js file!');
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

// ✅ Add Inventory Card (with image fetch)
app.post('/api/inventory', async (req, res) => {
  try {
    const { cardName, quantity, set, condition, foil, imageUrl } = req.body;

    if (!cardName || !quantity || !set || !condition) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    // Look for an existing card with same name + set + foil status
    const existingCard = await CardInventory.findOne({
      cardName,
      set,
      foil: !!foil
    });

    if (existingCard) {
      // 🔁 Update quantity if card already exists
      existingCard.quantity += parseInt(quantity);
      await existingCard.save();
      console.log(`🆙 Updated quantity of ${cardName} (${set}) to ${existingCard.quantity}`);
      return res.status(200).json({ message: 'Card quantity updated.', card: existingCard });
    }

    // 🔍 Get image from Scryfall if not provided
    let finalImageUrl = imageUrl?.trim();
    if (!finalImageUrl) {
      finalImageUrl = await fetchScryfallImageUrl(cardName, set);
    }

    // 🆕 Create new card
    const card = new CardInventory({
      cardName,
      quantity: parseInt(quantity),
      set,
      condition,
      foil: !!foil,
      imageUrl: finalImageUrl
    });

    await card.save();
    console.log(`✅ Added new card ${cardName} (${set}) to inventory`);
    res.status(201).json({ message: 'Card added to inventory.', card });
  } catch (err) {
    console.error('❌ Error adding/updating card:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
