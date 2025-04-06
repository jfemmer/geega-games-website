const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
require('dotenv').config();

const app = express();

app.get('/api/version-check', (req, res) => {
  res.send('✅ This is the latest version of the server.js file!');
});

// ✅ Middleware
app.use(cors());
app.use(express.json());

// ✅ Environment variables
const MONGODB_URI = process.env.MONGODB_URI;
const port = process.env.PORT || 3000;

if (!MONGODB_URI) {
  console.error('❌ MONGODB_URI is not set in environment variables!');
  process.exit(1);
}

// ✅ Connect to MongoDB Atlas
mongoose.connect(MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ Connected to MongoDB Atlas'))
.catch((err) => {
  console.error('❌ MongoDB connection error:', err.message);
  process.exit(1);
});

// ✅ Mongoose Schema & Model
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

// ✅ Root Route (Test)
app.get('/', (req, res) => {
  res.send('🧙‍♂️ Welcome to the Geega Games API!');
});

// ✅ Signup Route
app.post('/signup', async (req, res) => {
  try {
    const {
      firstName, lastName, username, email, password,
      phone, address, state, zip
    } = req.body;

    // Minimal validation
    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Username, email, and password are required.' });
    }

    // Check if user already exists
    const existing = await User.findOne({ $or: [{ email }, { username }] });
    if (existing) {
      return res.status(409).json({ message: 'User already exists.' });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create new user
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

// ✅ Get all users (for admin dashboard)
app.get('/api/users', async (req, res) => {
  try {
    const users = await User.find(); // select only relevant fields
    res.json(users);
  } catch (err) {
    console.error('❌ Error fetching users:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// ✅ Start Server
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
