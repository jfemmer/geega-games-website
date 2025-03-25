const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const CARDS_FILE = path.join(__dirname, 'cards.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// Ensure cards.json exists
if (!fs.existsSync(CARDS_FILE)) {
    fs.writeFileSync(CARDS_FILE, '[]', 'utf8');
}

// Ensure users.json exists
if (!fs.existsSync(USERS_FILE)) {
    fs.writeFileSync(USERS_FILE, '[]', 'utf8');
}

// In-memory cache
const ebayPriceCache = {};
const CACHE_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

// Register new user endpoint
app.post('/register', (req, res) => {
    const { username, email, password, phone, address, state, zip } = req.body;

    if (!username || !email || !password || !phone || !address || !state || !zip) {
        return res.status(400).json({ message: "Missing required user fields." });
    }

    const newUser = {
        username: username.trim(),
        email: email.trim(),
        password: password.trim(), // For demo purposes only; hash in production
        phone: phone.trim(),
        address: address.trim(),
        state: state.trim(),
        zip: zip.trim()
    };

    fs.readFile(USERS_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('❌ Error reading users.json:', err);
            return res.status(500).json({ message: "Server error reading users.json." });
        }

        let users = [];

        try {
            users = JSON.parse(data);
        } catch (parseError) {
            console.error('❌ Error parsing users.json:', parseError);
            return res.status(500).json({ message: "Server error parsing users.json." });
        }

        // Optional: check if username or email already exists

        users.push(newUser);

        fs.writeFile(USERS_FILE, JSON.stringify(users, null, 4), 'utf8', (writeErr) => {
            if (writeErr) {
                console.error('❌ Error writing to users.json:', writeErr);
                return res.status(500).json({ message: "Server error writing to users.json." });
            }

            console.log(`✅ New user registered: ${username}`);
            res.json({ message: "User successfully registered!" });
        });
    });
});

// Add-card endpoint
app.post('/add-card', (req, res) => {
    const { name, set, quantity, imageURL } = req.body;

    if (!name || !set || !quantity || !imageURL) {
        console.warn('⚠️  Missing data in request:', req.body);
        return res.status(400).json({ message: "Missing required card fields." });
    }

    const newCard = {
        Name: name.trim(),
        Set: set.trim().toUpperCase(),
        Quantity: parseInt(quantity, 10),
        ImageURL: imageURL
    };

    fs.readFile(CARDS_FILE, 'utf8', (err, data) => {
        if (err) {
            console.error('❌ Error reading cards.json:', err);
            return res.status(500).json({ message: "Server error reading cards.json." });
        }

        let cards = [];

        try {
            cards = JSON.parse(data);
        } catch (parseError) {
            console.error('❌ Error parsing cards.json:', parseError);
            return res.status(500).json({ message: "Server error parsing cards.json." });
        }

        cards.push(newCard);

        fs.writeFile(CARDS_FILE, JSON.stringify(cards, null, 4), 'utf8', (writeErr) => {
            if (writeErr) {
                console.error('❌ Error writing to cards.json:', writeErr);
                return res.status(500).json({ message: "Server error writing to cards.json." });
            }

            console.log(`✅ Card added: ${name} (${set}), Qty: ${quantity}`);
            res.json({ message: "Card successfully added!" });
        });
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Geega Games Inventory Server running at http://localhost:${PORT}`);
});
