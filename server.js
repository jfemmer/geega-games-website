// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();

// ✅ Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const INVENTORY_DB_URI = process.env.INVENTORY_DB_URI;
const EMPLOYEE_DB_URI = process.env.EMPLOYEE_DB_URI;
const TRADEIN_DB_URI = process.env.TRADEIN_DB_URI;
const port = process.env.PORT || 3000;

if (!MONGODB_URI || !INVENTORY_DB_URI || !EMPLOYEE_DB_URI || !TRADEIN_DB_URI) {
  console.error('❌ One or more MongoDB URIs are missing in environment variables!');
  process.exit(1);
}

// ✅ Connect to MongoDB
const db1 = mongoose.createConnection(MONGODB_URI);
const inventoryConnection = mongoose.createConnection(INVENTORY_DB_URI);
const employeeConnection = mongoose.createConnection(EMPLOYEE_DB_URI);
const tradeInConnection = mongoose.createConnection(TRADEIN_DB_URI);

// ✅ Load Cart model AFTER db1 is defined
const Cart = require('./models/Cart')(db1);

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
      specialArt: String, // e.g., "Showcase", "Borderless", etc.
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

// Root
app.get('/', (req, res) => res.send('🧙‍♂️ Welcome to the Geega Games API!'));

// Version Check
app.get('/api/version-check', (req, res) => res.send('✅ Latest server.js version'));


// 🔁 Get cart
// ✅ GET cart
app.get('/api/cart', async (req, res) => {
  const { userId } = req.query;
  console.log('📥 GET cart for:', userId);

  try {
    const cart = await Cart.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    console.log('📤 Returning cart:', cart);
    res.json(cart || { items: [] });
  } catch (err) {
    console.error('❌ Fetch cart error:', err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// ✅ POST add item to cart
app.post('/api/cart', async (req, res) => {
  const { userId, item } = req.body;
  console.log('📦 Incoming cart request:', { userId, item });

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    let cart = await Cart.findOne({ userId: objectId });
    console.log('🛒 Existing cart:', cart);

    if (!cart) {
      cart = new Cart({ userId: objectId, items: [item] });
    } else {
      const key = `${item.cardName}|${item.set}|${item.foil}|${item.condition}|${item.variantType}`;
      const existing = cart.items.find(i =>
        `${i.cardName}|${i.set}|${i.foil}|${i.condition}|${i.variantType}` === key
      );

      if (existing) {
        existing.quantity += item.quantity;
      } else {
        cart.items.push(item);
      }
    }

    cart.updatedAt = new Date();
    await cart.save();
    res.status(200).json({ message: 'Item added to cart' });
  } catch (err) {
    console.error('❌ Add to cart error:', err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// ✅ POST remove item by index
app.post('/api/cart/remove', async (req, res) => {
  const { userId, index } = req.body;
  try {
    const cart = await Cart.findOne({ userId: new mongoose.Types.ObjectId(userId) });
    if (!cart || index < 0 || index >= cart.items.length) {
      return res.status(400).json({ message: 'Invalid index or cart not found.' });
    }

    cart.items.splice(index, 1);
    cart.updatedAt = new Date();
    await cart.save();
    res.status(200).json({ message: 'Item removed from cart' });
  } catch (err) {
    console.error('❌ Remove from cart error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// ✅ POST clear cart
app.post('/api/cart/clear', async (req, res) => {
  const { userId } = req.body;
  try {
    await Cart.findOneAndUpdate(
      { userId: new mongoose.Types.ObjectId(userId) },
      { items: [], updatedAt: new Date() }
    );
    res.status(200).json({ message: 'Cart cleared' });
  } catch (err) {
    console.error('❌ Clear cart error:', err);
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

app.post('/api/orders', async (req, res) => {
  const { userId, firstName, email, cards } = req.body;

  if (!userId || !cards || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ message: 'Invalid order data.' });
  }

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


// Start Server
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
