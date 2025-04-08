const express = require('express'); 
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
require('dotenv').config();

const app = express();

// ✅ Middleware
app.use(cors());
app.use(express.json());

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
  cardName: String,
  quantity: Number,
  set: String,
  condition: String,
  foil: Boolean,
  imageUrl: String, // ✅ Add this if it's not already in your schema
  addedAt: { type: Date, default: Date.now }
});

// Force collection name: 'Card Inventory'
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

// ✅ Get All Users (Admin Dashboard) — sorted by newest
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 }); // 👈 newest first
    res.json(users);
  } catch (err) {
    console.error('❌ Error fetching users:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});



const axios = require('axios');

app.post('/api/inventory', async (req, res) => {
  console.log('📥 Received inventory POST:', req.body);

  try {
    const { cardName, quantity, set, condition, foil } = req.body;

    if (!cardName || !quantity || !set || !condition) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    // 🖼️ Function to fetch image URL from Scryfall
    const fetchImageURL = async (name, setCode) => {
      const cleanedName = name.split('(')[0].trim();
      const loweredName = name.toLowerCase();
      let query = `${cleanedName} set:${setCode.toLowerCase()}`;

      if (loweredName.includes('borderless')) query += ' is:borderless';
      if (loweredName.includes('showcase')) query += ' frame:showcase';
      if (loweredName.includes('extended')) query += ' frame:extendedart';
      if (loweredName.includes('oil slick')) query += ' frame:oil_slicked';
      if (loweredName.includes('serialized')) query += ' frame:serialized';

      const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`;

      try {
        const response = await axios.get(url);
        const cardData = response.data.data[0];

        if (cardData.image_uris) return cardData.image_uris.normal;
        if (cardData.card_faces?.[0]?.image_uris) return cardData.card_faces[0].image_uris.normal;
      } catch (error) {
        console.error('🛑 Scryfall image fetch failed:', error.message);
        return null;
      }

      return null;
    };

    // 🔎 Fetch the Scryfall image URL
    const imageUrl = await fetchImageURL(cardName, set);

    // Save card to MongoDB
    const card = new CardInventory({
      cardName,
      quantity,
      set,
      condition,
      foil: !!foil,
      imageUrl // Add to DB
    });

    await card.save();

    res.status(201).json({ message: '🃏 Card added with image!', imageUrl });
  } catch (err) {
    console.error('❌ Error adding card to inventory:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});
// ✅ Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
