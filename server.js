// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto'); // ✅ NEW (email verification)
require('dotenv').config();
console.log("Stripe key exists?", !!process.env.STRIPE_SECRET_KEY);

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const app = express();

// 🆕 NEW: Multer + Tesseract
const multer = require('multer');
const Tesseract = require('tesseract.js');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const uspsUserID = process.env.USPS_USER_ID;
const getShippo = require('./shippo-wrapper');

const UPLOAD_DIR = path.join(__dirname, "uploads");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const DEBUG_OCR = true;

const DEBUG_DIR = path.join(__dirname, "ocr_debug");

if (!fs.existsSync(DEBUG_DIR)) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
}


const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5   // good idea to limit
  }
});

// Email + Twilio
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const xml2js = require('xml2js');
const parser = new xml2js.Parser();

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.NOTIFY_EMAIL,
    pass: process.env.NOTIFY_PASSWORD,
  }
});

const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// ✅ NEW: Email verification helpers
function createEmailVerificationToken() {
  const token = crypto.randomBytes(32).toString('hex'); // sent to user
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex'); // stored in DB
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24); // 24 hours
  return { token, tokenHash, expires };
}


const allowedOrigins = [
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'https://jfemmer.github.io',
  'https://www.geega-games.com',
  'https://geega-games.com'
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      console.log("❌ Blocked by CORS:", origin);
      return callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));



async function sendVerificationEmail({ toEmail, firstName, verifyUrl }) {
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.4">
      <h2 style="color:#663399;margin:0 0 12px 0;">Verify your email</h2>
      <p>Hey ${firstName || 'there'} 👋</p>
      <p>Thanks for signing up for Geega Games! Click the button below to verify your email:</p>
      <p>
        <a href="${verifyUrl}"
           style="display:inline-block;background:#663399;color:white;padding:12px 16px;border-radius:10px;text-decoration:none;font-weight:bold;">
          Verify Email
        </a>
      </p>
      <p style="font-size:12px;color:#666;margin-top:18px;">
        If you didn’t create an account, you can ignore this email.
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `Geega Games <${process.env.NOTIFY_EMAIL}>`,
    to: toEmail,
    subject: 'Verify your Geega Games email',
    html
  });
}


// ✅ High-accuracy FI-8170 OCR upgrade for /api/fi8170/scan-to-inventory
// Requires: sharp, fs, path, Tesseract, axios, CardInventory already set up

// ---------- High-accuracy OCR helpers (put these ABOVE the route) ----------

// Your FI-8170 sample image format (you said all scans match this):
const FIXED_DIMS = { w: 771, h: 1061 };

// Tuned crop boxes for the FI-8170 format
const CROP = {
  // Top name bar strip
  nameBar: { left: 80, top: 32, width: 520, height: 85},

  // Optional later if you want collector # matching:
  bottomLine: { left: 154, top: 923, width: 462, height: 127 },
};

function cleanCardName(text) {
  return (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9 ',-/]/g, "") // keep split cards: Fire // Ice
    .trim();
}

async function cropAndPrepNameBar(originalPath, outPath, useThreshold = false) {
  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  // Fixed coords if exact match, otherwise % fallback
  const region =
    W === FIXED_DIMS.w && H === FIXED_DIMS.h
      ? CROP.nameBar
      : {
  left: Math.floor(W * 0.09),   // was 0.05
  top: Math.floor(H * 0.07),   // was 0.03
  width: Math.floor(W * 0.75),  // was 0.90
  height: Math.floor(H * 0.04), // was 0.16
}

  let pipeline = sharp(originalPath)
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    // Upscale the CROP (not the whole image) for better OCR edges:
    .resize({ width: 1400, withoutEnlargement: false });

  if (useThreshold) {
    // Stronger second pass when confidence is low
    pipeline = pipeline.threshold(180);
  }

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    await sharp(outPath).toFile(debugCopy);
    console.log("🟣 Saved NAME crop to:", debugCopy);
  }
}

// Updated recognizeWithTimeout: supports passing Tesseract options
function recognizeWithTimeout(imagePath, ms = 30000, tesseractOptions = {}) {
  return Promise.race([
    Tesseract.recognize(imagePath, "eng", tesseractOptions),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`OCR timeout after ${ms}ms`)), ms)
    ),
  ]);
}

async function ocrCardNameHighAccuracy(originalPath, tmpDir) {
  const ts = Date.now();
  const nameCrop1 = path.join(tmpDir, `name_${ts}_p1.png`);
  const nameCrop2 = path.join(tmpDir, `name_${ts}_p2.png`);

  const tesseractOptions = {
    // SINGLE_LINE = PSM 7 (best for a name bar)
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-/",
  };

  // Pass 1 (normal)
  await cropAndPrepNameBar(originalPath, nameCrop1, false);
  const ocr1 = await recognizeWithTimeout(nameCrop1, 90000, tesseractOptions);
  const name1 = cleanCardName(ocr1?.data?.text);
  const conf1 = ocr1?.data?.confidence ?? 0;

  // If pass 1 is good, return early
  if (name1 && conf1 >= 65) {
    try { if (fs.existsSync(nameCrop1)) fs.unlinkSync(nameCrop1); } catch {}
    return { name: name1, confidence: conf1 };
  }

  // Pass 2 (threshold retry)
  await cropAndPrepNameBar(originalPath, nameCrop2, true);
  const ocr2 = await recognizeWithTimeout(nameCrop2, 90000, tesseractOptions);
  const name2 = cleanCardName(ocr2?.data?.text);
  const conf2 = ocr2?.data?.confidence ?? 0;

  // Cleanup
  for (const p of [nameCrop1, nameCrop2]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  // Choose best
  if (!name1 && name2) return { name: name2, confidence: conf2 };
  if (!name2 && name1) return { name: name1, confidence: conf1 };
  if (name2 && conf2 > conf1) return { name: name2, confidence: conf2 };

  return { name: name1 || name2 || "", confidence: Math.max(conf1, conf2) };
}

function cleanBottomText(text) {
  return (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCollectorNumber(bottomText) {
  // "123/281" or "123 / 281"
  const m = bottomText.match(/(\d{1,4})\s*\/\s*\d{1,4}/);
  if (m) return m[1];

  // fallback: first standalone number (less safe, but useful)
  const m2 = bottomText.match(/\b(\d{1,4})\b/);
  return m2 ? m2[1] : null;
}

async function cropAndPrepBottomLine(originalPath, outPath, useThreshold = false) {
  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const region =
    W === FIXED_DIMS.w && H === FIXED_DIMS.h
      ? CROP.bottomLine
      : {
          left: Math.floor(W * 0.08),
          top: Math.floor(H * 0.67),
          width: Math.floor(W * 0.3),
          height: Math.floor(H * 0.12),
        };

  let pipeline = sharp(originalPath)
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 1600, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(180);

  await pipeline.toFile(outPath);
  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    await sharp(outPath).toFile(debugCopy);
    console.log("🔵 Saved BOTTOM crop to:", debugCopy);
  }
}

async function ocrCollectorNumberHighAccuracy(originalPath, tmpDir) {
  const ts = Date.now();
  const bottomCrop1 = path.join(tmpDir, `bottom_${ts}_p1.png`);
  const bottomCrop2 = path.join(tmpDir, `bottom_${ts}_p2.png`);

  const opts = {
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK, // PSM 6
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/ ",
  };

  await cropAndPrepBottomLine(originalPath, bottomCrop1, false);
  const ocr1 = await recognizeWithTimeout(bottomCrop1, 90000, opts);
  const text1 = cleanBottomText(ocr1?.data?.text);
  const conf1 = ocr1?.data?.confidence ?? 0;

  await cropAndPrepBottomLine(originalPath, bottomCrop2, true);
  const ocr2 = await recognizeWithTimeout(bottomCrop2, 90000, opts);
  const text2 = cleanBottomText(ocr2?.data?.text);
  const conf2 = ocr2?.data?.confidence ?? 0;

  for (const p of [bottomCrop1, bottomCrop2]) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }

  const bestText = conf2 > conf1 ? text2 : text1;
  const bestConf = Math.max(conf1, conf2);

  return {
    text: bestText,
    confidence: bestConf,
    collectorNumber: parseCollectorNumber(bestText),
  };
}

// ---------- UPDATED ROUTE (FULL) ----------
// Assumes you already have:
// - upload (multer) configured
// - fs, path, axios imported
// - CardInventory model
// - ocrCardNameHighAccuracy(...) helper
// - ocrCollectorNumberHighAccuracy(...) helper (bottom-line OCR)
// - pickPrintingByCollector(...) helper (optional but recommended)

app.post("/api/fi8170/scan-to-inventory", upload.array("cardImages"), async (req, res) => {
  const started = Date.now();

  try {
    const { condition, foil } = req.body;
    const files = req.files;

    console.log("📥 [fi8170] HIT", {
      time: new Date().toISOString(),
      files: files?.length || 0,
      condition,
      foil,
      setCode: req.body?.setCode
    });

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No images uploaded." });
    }

    const isFoil = String(foil) === "true";
    const results = [];

    // Use a temp dir for crops (you can change this if you want)
    const tmpDir = path.join(__dirname, "uploads");
    try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

    // Batch-level setCode (optional, best if you can provide it)
    const setCodeFromBody = (req.body.setCode || "").trim().toLowerCase();

    for (const file of files) {
      const perFileStart = Date.now();
      const originalPath = file.path;

      try {
        console.log("🖼️ [fi8170] file start:", {
          originalname: file.originalname,
          path: file.path,
          size: file.size
        });

        // 1) HIGH-ACCURACY OCR: NAME BAR
        console.log("🔤 [fi8170] OCR(name bar) start");
        const { name: guessedName, confidence: nameConf } =
          await ocrCardNameHighAccuracy(originalPath, tmpDir);
        console.log("🔤 [fi8170] OCR(name bar) done", {
          guessedName,
          nameConf: Math.round(nameConf)
        });

        if (!guessedName || guessedName.length < 3) {
          results.push({
            file: file.originalname,
            error: "Could not detect card name from name bar.",
            ms: Date.now() - perFileStart
          });
          continue;
        }

        // Optional safety: avoid auto-inserting if OCR is too uncertain
        if (nameConf < 45) {
          results.push({
            file: file.originalname,
            error: `Low OCR confidence (${Math.round(nameConf)}). Needs review.`,
            guessedName,
            ms: Date.now() - perFileStart
          });
          continue;
        }

        // 1b) HIGH-ACCURACY OCR: COLLECTOR NUMBER (bottom line)
        // This enables “99% correct printing” selection.
        console.log("🔢 [fi8170] OCR(bottom line) start");
        const bottom = await ocrCollectorNumberHighAccuracy(originalPath, tmpDir);
        const collectorNumber = bottom.collectorNumber; // may be null
        console.log("🔢 [fi8170] OCR(bottom line) done", {
          bottomText: bottom.text,
          bottomConf: Math.round(bottom.confidence),
          collectorNumber
        });

        // 2) SCRYFALL: pick the RIGHT set/printing
        console.log("🧙 [fi8170] Scryfall start");

        let card = null;

        try {
          // Always get a base card first (fast + reliable)
          const baseRes = await axios.get(
            `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(guessedName)}`
          );
          const base = baseRes.data;

          if (collectorNumber) {
            // Best path: if you know the set code, do exact set+collector lookup
            if (setCodeFromBody) {
              const exactRes = await axios.get(
                `https://api.scryfall.com/cards/${encodeURIComponent(setCodeFromBody)}/${encodeURIComponent(collectorNumber)}`
              );
              card = exactRes.data;
            } else if (base?.prints_search_uri && typeof pickPrintingByCollector === "function") {
              // Strong path even without setCode: search printings and match collector_number
              const picked = await pickPrintingByCollector(base.prints_search_uri, collectorNumber, isFoil);
              card = picked || base;
            } else {
              // Fallback if prints_search_uri helper not present
              card = base;
            }
          } else {
            // No collector number available: still try to constrain by set code if provided
            if (setCodeFromBody) {
              const query = `!"${guessedName}" set:${setCodeFromBody}`;
              const s = await axios.get(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`);
              card = s.data.data?.[0] || base;
            } else {
              card = base;
            }
          }

          if (!card) throw new Error("No Scryfall card selected");

        } catch (err) {
          results.push({
            file: file.originalname,
            error: `Scryfall lookup failed: ${guessedName}`,
            ms: Date.now() - perFileStart
          });
          continue;
        }

        console.log("🧙 [fi8170] Scryfall chosen:", {
          name: card?.name,
          set: card?.set,
          set_name: card?.set_name,
          collector_number: card?.collector_number
        });

        const price = isFoil
          ? parseFloat(card?.prices?.usd_foil || card?.prices?.usd || 0)
          : parseFloat(card?.prices?.usd || 0);

        // 3) Save to inventory (no quantity conflict)
        const inventoryItem = {
          cardName: card.name,
          set: card.set_name,
          condition,
          foil: isFoil,
          priceUsd: price,
          imageUrl: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || ""
        };

        console.log("💾 [fi8170] DB upsert start");
        await CardInventory.findOneAndUpdate(
          {
            cardName: inventoryItem.cardName,
            set: inventoryItem.set,
            foil: inventoryItem.foil,
            condition: inventoryItem.condition
          },
          {
            $inc: { quantity: 1 },        // creates quantity on insert automatically
            $setOnInsert: inventoryItem    // do NOT include quantity here
          },
          { upsert: true }
        );
        console.log("💾 [fi8170] DB upsert done");

        results.push({
          file: file.originalname,
          success: card.name,
          guessedName,
          nameConfidence: Math.round(nameConf),
          collectorNumber: collectorNumber || null,
          chosenSet: card?.set || null,
          chosenSetName: card?.set_name || null,
          chosenCollector: card?.collector_number || null,
          ms: Date.now() - perFileStart
        });

      } catch (err) {
        console.error("❌ [fi8170] per-file error:", file?.originalname, err?.message || err);
        results.push({
          file: file.originalname,
          error: err?.message || "Unknown error",
          ms: Date.now() - perFileStart
        });
      } finally {
        // Cleanup original uploads (keep if you want debugging)
        try { if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath); } catch {}
      }
    }

    console.log("✅ [fi8170] DONE ms:", Date.now() - started);
    return res.json({ results });

  } catch (err) {
    console.error("❌ [fi8170] route error:", err);
    return res.status(500).json({ error: "Server error processing scans." });
  }
});

// ✅ IMPORTANT: place this ABOVE app.use(express.json())
app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('❌ Webhook signature failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'payment_intent.succeeded') {
      const pi = event.data.object;

      const updated = await Order.findOneAndUpdate(
        { stripePaymentIntentId: pi.id },
        { paymentStatus: 'paid' },
        { new: true }
      );

      if (!updated) {
        console.warn('⚠️ No order found for PaymentIntent:', pi.id);
      } else {
        console.log('✅ Order marked paid:', updated._id, pi.id);
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const pi = event.data.object;
      await Order.findOneAndUpdate(
        { stripePaymentIntentId: pi.id },
        { paymentStatus: 'unpaid' }
      );
      console.log('⚠️ Payment failed:', pi.id);
    }

    return res.json({ received: true });
  } catch (e) {
    console.error('❌ Webhook handler error:', e);
    // Still return 200 so Stripe doesn’t hammer retries while you debug
    return res.json({ received: true });
  }
});


app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/ocr_debug', express.static(path.join(__dirname, 'ocr_debug')));

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

if (!MONGODB_URI || !INVENTORY_DB_URI || !EMPLOYEE_DB_URI || !TRADEIN_DB_URI) {
  console.error('❌ One or more MongoDB URIs are missing in environment variables!');
  process.exit(1);
}

// ✅ Connect to MongoDB
const db1 = mongoose.createConnection(MONGODB_URI);
const inventoryConnection = mongoose.createConnection(INVENTORY_DB_URI);
const employeeConnection = mongoose.createConnection(EMPLOYEE_DB_URI);
const tradeInConnection = mongoose.createConnection(TRADEIN_DB_URI);

const createCartModel = require('./models/Cart');
const Cart = createCartModel(db1);

// ✅ Connection Logs
[db1, inventoryConnection, employeeConnection, tradeInConnection].forEach((db, i) => {
  db.on('connected', () => console.log(`✅ Connected to MongoDB database #${i + 1}`));
  db.on('error', (err) => console.error(`❌ MongoDB connection error #${i + 1}:`, err.message));
});

const scanJobSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["queued", "processing", "done", "failed"], default: "queued" },

    // File info
    filePath: { type: String, required: true },
    originalName: { type: String, default: "" },

    // Batch inputs
    condition: { type: String, default: "NM" },
    foil: { type: Boolean, default: false },
    setCode: { type: String, default: "" },

    // Results
    guessedName: String,
    nameConfidence: Number,
    collectorNumber: String,
    chosenSet: String,
    chosenSetName: String,
    chosenCollector: String,
    ocrTextName: String,
    ocrTextBottom: String,

    // Ops
    attempts: { type: Number, default: 0 },
    lastError: String,
    lockedAt: Date,
    finishedAt: Date
  },
  { timestamps: true }
);

// Use primary DB for jobs
const ScanJob = db1.model("ScanJob", scanJobSchema, "Scan Jobs");

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
  createdAt: { type: Date, default: Date.now },

  // ✅ Email verification
  isEmailVerified: { type: Boolean, default: false },
  emailVerificationTokenHash: { type: String },
  emailVerificationExpires: { type: Date },

  // ✅ Notification Preferences
  announcementNotifications: {
    enabled: { type: Boolean, default: false },
    byEmail: { type: Boolean, default: true },
    byText: { type: Boolean, default: false }
  },

  shippingNotifications: {
    enabled: { type: Boolean, default: true },
    byEmail: { type: Boolean, default: true },
    byText: { type: Boolean, default: false }
  }
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
  priceUsd: Number,
  priceUsdFoil: Number,
  variantType: String,  // ✅ Add this
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
      quantity: Number,
      imageUrl: String,
      priceUsd: Number,
      condition: String
    }
  ],
  shippingMethod: String,
  paymentMethod: String,

  // ✅ NEW: Stripe reconciliation fields
  stripePaymentIntentId: String,
  paymentStatus: { type: String, default: 'unpaid' }, // unpaid, paid, refunded

  orderTotal: Number,
  submittedAt: { type: Date, default: Date.now },

  // 🆕 Status + Tracking Fields
  status: { type: String, default: 'Pending' },
  packedAt: Date,
  droppedOffAt: Date,
  trackingNumber: String,
  trackingCarrier: String,
  trackingHistory: [
    {
      timestamp: Date,
      status: String,
      details: String
    }
  ]
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
      quantity: { type: Number, default: 1 }
    },
  ],
  submittedAt: { type: Date, default: Date.now },

  status: {
    type: String,
    default: 'New'
  },
  estimatedValue: Number,
  totalCards: Number,
  source: String,
  notes: String,
  internalNotes: String
});

const TradeIn = tradeInConnection.model('TradeIn', tradeInSchema, 'TradeIns');

async function processSingleScanToInventory({ filePath, originalName, condition, foil, setCode }) {
  const perFileStart = Date.now();
  const tmpDir = path.join(__dirname, "uploads");
  try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  const isFoil = !!foil;
  const setCodeFromBody = (setCode || "").trim().toLowerCase();

  // 1) OCR: name bar
  const { name: guessedName, confidence: nameConf } = await ocrCardNameHighAccuracy(filePath, tmpDir);

  if (!guessedName || guessedName.length < 3) {
    throw new Error("Could not detect card name from name bar.");
  }

  if (nameConf < 45) {
    throw new Error(`Low OCR confidence (${Math.round(nameConf)}). Needs review.`);
  }

  // 1b) OCR: bottom line (collector number)
  const bottom = await ocrCollectorNumberHighAccuracy(filePath, tmpDir);
  const collectorNumber = bottom.collectorNumber || null;

  // 2) Scryfall select printing
  let card = null;

  const baseRes = await axios.get(
    `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(guessedName)}`
  );
  const base = baseRes.data;

  if (collectorNumber) {
    if (setCodeFromBody) {
      const exactRes = await axios.get(
        `https://api.scryfall.com/cards/${encodeURIComponent(setCodeFromBody)}/${encodeURIComponent(collectorNumber)}`
      );
      card = exactRes.data;
    } else if (base?.prints_search_uri && typeof pickPrintingByCollector === "function") {
      const picked = await pickPrintingByCollector(base.prints_search_uri, collectorNumber, isFoil);
      card = picked || base;
    } else {
      card = base;
    }
  } else {
    if (setCodeFromBody) {
      const query = `!"${guessedName}" set:${setCodeFromBody}`;
      const s = await axios.get(`https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`);
      card = s.data.data?.[0] || base;
    } else {
      card = base;
    }
  }

  if (!card) throw new Error("No Scryfall card selected");

  const price = isFoil
    ? parseFloat(card?.prices?.usd_foil || card?.prices?.usd || 0)
    : parseFloat(card?.prices?.usd || 0);

  const inventoryItem = {
    cardName: card.name,
    set: card.set_name,
    condition,
    foil: isFoil,
    priceUsd: price,
    imageUrl: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || ""
  };

  await CardInventory.findOneAndUpdate(
    {
      cardName: inventoryItem.cardName,
      set: inventoryItem.set,
      foil: inventoryItem.foil,
      condition: inventoryItem.condition
    },
    {
      $inc: { quantity: 1 },
      $setOnInsert: inventoryItem
    },
    { upsert: true }
  );

  return {
    ms: Date.now() - perFileStart,
    guessedName,
    nameConfidence: Math.round(nameConf),
    collectorNumber,
    chosenSet: card?.set || null,
    chosenSetName: card?.set_name || null,
    chosenCollector: card?.collector_number || null,
    ocrTextName: null,                 // optional: store raw Tesseract output if you want
    ocrTextBottom: bottom?.text || null
  };
}

function requireIngestKey(req, res, next) {
  const key = req.headers["x-ingest-key"];
  if (!process.env.INGEST_KEY || key !== process.env.INGEST_KEY) {
    return res.status(401).send("Unauthorized");
  }
  next();
}

// Single-file ingest (separate from your fi8170 batch route)
app.post("/api/scan-ingest", requireIngestKey, upload.single("image"), async (req, res) => {
  try {
    if (!req.file?.path) return res.status(400).json({ message: "No image uploaded." });

    const condition = (req.body.condition || "NM").trim();
    const foil = String(req.body.foil) === "true";
    const setCode = (req.body.setCode || "").trim().toLowerCase();

    const job = await ScanJob.create({
      status: "queued",
      filePath: req.file.path,
      originalName: req.body.originalName || req.file.originalname || "",
      condition,
      foil,
      setCode
    });

    res.json({ jobId: String(job._id), status: job.status });
  } catch (e) {
    console.error("❌ scan-ingest error:", e);
    res.status(500).json({ message: "Failed to ingest scan." });
  }
});

// ✅ Routes

// Root
app.get('/', (req, res) => res.send('🧙‍♂️ Welcome to the Geega Games API!'));

// Version Check
app.get('/api/version-check', (req, res) => res.send('✅ Latest server.js version'));

// ✅ Email verification: click link route
app.get('/verify-email', async (req, res) => {
  try {
    const { token, email } = req.query;
    if (!token || !email) return res.status(400).send('Missing token or email.');

    const normalizedEmail = String(email).toLowerCase().trim();
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');

    const user = await User.findOne({
      email: normalizedEmail,
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpires: { $gt: new Date() }
    });

    if (!user) {
      return res.status(400).send('Verification link is invalid or expired.');
    }

    user.isEmailVerified = true;
    user.emailVerificationTokenHash = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    const siteUrl = process.env.PUBLIC_SITE_URL || 'https://www.geega-games.com';
    return res.redirect(`${siteUrl}/login.html?verified=1`);
  } catch (err) {
    console.error('❌ verify-email error:', err);
    return res.status(500).send('Server error verifying email.');
  }
});

// ✅ Email verification: resend
app.post('/api/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    const normalizedEmail = String(email || '').toLowerCase().trim();

    // Always respond safely so you don't leak whether an email exists
    const safeOk = () => res.status(200).json({ message: 'If that email exists, we sent a new verification link.' });

    if (!normalizedEmail) return safeOk();

    const user = await User.findOne({ email: normalizedEmail });
    if (!user) return safeOk();

    if (user.isEmailVerified) {
      return res.status(200).json({ message: 'Email is already verified. You can log in.' });
    }

    const { token, tokenHash, expires } = createEmailVerificationToken();
    user.emailVerificationTokenHash = tokenHash;
    user.emailVerificationExpires = expires;
    await user.save();

    const apiBase = process.env.API_BASE_URL || 'https://geega-games-website-production.up.railway.app';
    const verifyUrl = `${apiBase}/verify-email?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;

    await sendVerificationEmail({
      toEmail: normalizedEmail,
      firstName: user.firstName,
      verifyUrl
    });

    return res.status(200).json({ message: 'Verification email resent. Check your inbox.' });
  } catch (err) {
    console.error('❌ resend-verification error:', err);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});

// 🛒 GET cart
app.get('/api/cart', async (req, res) => {
  const { userId } = req.query;
  console.log('📥 [GET] /api/cart - Received userId:', userId);

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (GET):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    console.log('🔍 Converted userId to ObjectId:', objectId);

    const cart = await Cart.findOne({ userId: objectId });
    console.log('📦 Cart query result:', cart);

    res.json(cart ? { items: cart.items || [] } : { items: [] });
  } catch (err) {
    console.error('❌ [GET] Fetch cart error:', err.stack || err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

// 🛒 POST add item to cart
app.post('/api/cart', async (req, res) => {
  const { userId, item } = req.body;
  console.log('📥 [POST] /api/cart - Payload:', { userId, item });

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (POST):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  if (!item || !item.cardName || !item.set || !item.condition || item.quantity == null) {
    console.warn('⚠️ Missing required item fields:', item);
    return res.status(400).json({ message: 'Missing required item fields (cardName, set, condition, quantity).' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);

    const inventoryItem = await CardInventory.findOne({
      cardName: item.cardName,
      set: item.set,
      foil: !!item.foil,
      condition: item.condition
    });

    if (!inventoryItem) {
      console.warn('⚠️ Inventory item not found:', item);
      return res.status(404).json({ message: 'Item not found in inventory.' });
    }

    let cart = await Cart.findOne({ userId: objectId });
    console.log('🛒 Existing cart:', cart || 'None found');

    if (!cart) {
      console.log('➕ Creating new cart');
      const qtyToAdd = Math.min(item.quantity, inventoryItem.quantity);
      cart = new Cart({ userId: objectId, items: [{ ...item, quantity: qtyToAdd }] });
    } else {
      const itemVariantKey = item.variantType || '';
      const key = `${item.cardName}|${item.set}|${item.foil}|${item.condition}|${itemVariantKey}`;

      const existing = cart.items.find(i => {
        const iVariantKey = i.variantType || '';
        return `${i.cardName}|${i.set}|${i.foil}|${i.condition}|${iVariantKey}` === key;
      });

      const currentQty = existing ? existing.quantity : 0;
      const allowedToAdd = inventoryItem.quantity - currentQty;

      if (allowedToAdd <= 0) {
        console.warn('⚠️ Max quantity already in cart.');
        return res.status(400).json({ message: 'You already have the maximum allowed quantity in your cart.' });
      }

      const qtyToAdd = Math.min(item.quantity, allowedToAdd);

      if (existing) {
        console.log(`🧩 Updating existing item with +${qtyToAdd}`);
        existing.quantity += qtyToAdd;
      } else {
        console.log(`🆕 Adding new item with quantity: ${qtyToAdd}`);
        cart.items.push({ ...item, quantity: qtyToAdd });
      }
    }

    cart.updatedAt = new Date();
    await cart.save();
    console.log('✅ Cart saved successfully');
    res.status(200).json({ message: 'Item added to cart' });
  } catch (err) {
    console.error('❌ [POST] Add to cart error:', err.stack || err);
    res.status(500).json({ message: 'Internal server error', error: err.message });
  }
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { userId, shippingMethod } = req.body;

    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ error: 'Invalid userId.' });
    }

    const method = (shippingMethod || 'tracked').toLowerCase();
    if (!['tracked', 'pwe'].includes(method)) {
      return res.status(400).json({ error: 'Invalid shipping method.' });
    }

    // 1) Load cart from DB
    const objectId = new mongoose.Types.ObjectId(userId);
    const cart = await Cart.findOne({ userId: objectId }).lean();
    const items = cart?.items || [];

    if (!items.length) {
      return res.status(400).json({ error: 'Cart is empty.' });
    }

    // 2) Reprice items from inventory (server-trusted)
    let subtotal = 0;

    for (const item of items) {
      const qty = Number(item.quantity || 1);

      // Match your inventory item as closely as possible
      const variantKey = (item.variantType || '').trim().toLowerCase();

      const inv = await CardInventory.findOne({
        cardName: item.cardName,
        set: item.set,
        foil: !!item.foil,
        condition: item.condition,
        variantType: variantKey
      }).lean();

      // If variantType doesn’t match or older rows have blank variantType, fall back
      const invFallback = inv || await CardInventory.findOne({
        cardName: item.cardName,
        set: item.set,
        foil: !!item.foil,
        condition: item.condition,
        $or: [
          { variantType: { $exists: false } },
          { variantType: '' },
          { variantType: null }
        ]
      }).lean();

      if (!invFallback) {
        return res.status(400).json({
          error: `Item not available: ${item.cardName} (${item.set}) ${item.foil ? 'Foil' : 'Non-Foil'} ${item.condition}`
        });
      }

      const unitPrice = item.foil
        ? Number(invFallback.priceUsdFoil ?? 0)
        : Number(invFallback.priceUsd ?? 0);

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        return res.status(400).json({
          error: `Invalid price for: ${item.cardName} (${item.set})`
        });
      }

      subtotal += unitPrice * qty;
    }

    // 3) Shipping rules (matches your UI)
    let shippingCost = 0;
    if (method === 'tracked') {
      shippingCost = subtotal >= 75 ? 0 : 5;
    } else if (method === 'pwe') {
      shippingCost = 1.25;
    }

    const orderTotal = Number((subtotal + shippingCost).toFixed(2));
    const amountCents = Math.round(orderTotal * 100);

    // 4) Create PaymentIntent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId: String(userId),
        shippingMethod: method,
        subtotal: subtotal.toFixed(2),
        shippingCost: shippingCost.toFixed(2)
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      orderTotal,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('❌ Stripe create-payment-intent error:', error);
    res.status(500).json({ error: error.message || 'Stripe error' });
  }
});

// 🗑️ POST remove item by index
app.post('/api/cart/remove', async (req, res) => {
  const { userId, index, quantity = 1 } = req.body;
  console.log('📥 [POST] /api/cart/remove - userId:', userId, 'index:', index, 'quantity:', quantity);

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (REMOVE):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    const cart = await Cart.findOne({ userId: objectId });

    if (!cart) {
      console.warn('⚠️ No cart found for userId:', userId);
      return res.status(404).json({ message: 'Cart not found.' });
    }

    if (index < 0 || index >= cart.items.length) {
      console.warn('⚠️ Index out of bounds:', index);
      return res.status(400).json({ message: 'Invalid index.' });
    }

    const item = cart.items[index];

    if (!item.quantity || typeof item.quantity !== 'number') {
      console.warn('⚠️ Invalid item quantity:', item.quantity);
      return res.status(400).json({ message: 'Invalid item quantity.' });
    }

    if (item.quantity > quantity) {
      console.log(`➖ Decreasing quantity of "${item.cardName}" from ${item.quantity} by ${quantity}`);
      cart.items[index].quantity -= quantity;
    } else {
      console.log(`🗑️ Removing entire item "${item.cardName}" from cart (quantity ${item.quantity})`);
      cart.items.splice(index, 1);
    }

    cart.updatedAt = new Date();
    await cart.save();

    res.status(200).json({ message: 'Item updated in cart' });
  } catch (err) {
    console.error('❌ [REMOVE] Error:', err.stack || err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// 🧹 POST clear cart
app.post('/api/cart/clear', async (req, res) => {
  const { userId } = req.body;
  console.log('📥 [POST] /api/cart/clear - userId:', userId);

  if (!mongoose.Types.ObjectId.isValid(userId)) {
    console.warn('⚠️ Invalid userId format (CLEAR):', userId);
    return res.status(400).json({ message: 'Invalid userId format.' });
  }

  try {
    const objectId = new mongoose.Types.ObjectId(userId);
    const result = await Cart.findOneAndUpdate(
      { userId: objectId },
      { items: [], updatedAt: new Date() }
    );

    console.log('🧹 Cart clear result:', result);
    res.status(200).json({ message: 'Cart cleared' });
  } catch (err) {
    console.error('❌ [CLEAR] Cart error:', err.stack || err);
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

// ✅ SIGNUP (UPDATED: creates user + emails verification link)
app.post('/signup', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      username,
      email,
      password,
      phone,
      address,
      state,
      zip,
      announcementNotifications,
      shippingNotifications
    } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await User.findOne({ $or: [{ email: normalizedEmail }, { username }] });
    if (existing) return res.status(409).json({ message: 'User already exists.' });

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Create email verification token
    const { token, tokenHash, expires } = createEmailVerificationToken();

    await new User({
      firstName,
      lastName,
      username,
      email: normalizedEmail,
      password: hashedPassword,
      phone,
      address,
      state,
      zip,

      announcementNotifications: {
        enabled: announcementNotifications?.enabled ?? false,
        byEmail: announcementNotifications?.byEmail ?? true,
        byText: announcementNotifications?.byText ?? false
      },
      shippingNotifications: {
        enabled: shippingNotifications?.enabled ?? true,
        byEmail: shippingNotifications?.byEmail ?? true,
        byText: shippingNotifications?.byText ?? false
      },

      // ✅ Verification fields
      isEmailVerified: false,
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpires: expires
    }).save();

    const apiBase = process.env.API_BASE_URL || 'https://geega-games-website-production.up.railway.app';
    const verifyUrl = `${apiBase}/verify-email?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;

    await sendVerificationEmail({
      toEmail: normalizedEmail,
      firstName,
      verifyUrl
    });

    res.status(201).json({
      message: '🐶 Welcome to the Pack! Check your email to verify your account before logging in.'
    });
  } catch (err) {
    console.error('❌ Signup error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// Login (UPDATED: blocks unverified email)
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email).toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: 'Invalid credentials.' });
    }

    if (!user.isEmailVerified) {
      return res.status(403).json({
        message: 'Please verify your email before logging in. Check your inbox for the verification link.',
        code: 'EMAIL_NOT_VERIFIED'
      });
    }

    res.json({
      message: 'Login successful',
      userId: user._id,
      username: user.username,
      firstName: user.firstName
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

app.get('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id).lean();

    if (!user) return res.status(404).json({ message: 'User not found.' });

    res.json(user);
  } catch (err) {
    console.error('❌ Fetch single user error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

// PATCH /api/users/:id - Update address info
app.patch('/api/users/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { address, state, zip } = req.body;

    const updated = await User.findByIdAndUpdate(
      id,
      { address, state, zip },
      { new: true }
    );

    if (!updated) return res.status(404).json({ message: 'User not found.' });

    res.json({ message: 'User updated.', user: updated });
  } catch (err) {
    console.error('❌ Failed to update user:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.post('/api/inventory', async (req, res) => {
  try {
    const { cardName, quantity, set, condition, foil, price } = req.body;
    let variantType = req.body.variantType || '';

    const incomingColors = Array.isArray(req.body.colors) ? req.body.colors : [];
    const incomingCardType = typeof req.body.cardType === 'string' ? req.body.cardType : '';
    const incomingCreatureTypes = Array.isArray(req.body.creatureTypes) ? req.body.creatureTypes : [];

    if (!cardName || quantity == null || !set || !condition) {
      return res.status(400).json({ message: 'Missing fields.' });
    }

    variantType = variantType.trim().toLowerCase();

    const imageUrl = req.body.imageUrl?.trim() || await fetchScryfallImageUrl(cardName, set);

    const parsedPrice = parseFloat(price) || 0;
    const priceUsd = foil ? 0 : parsedPrice;
    const priceUsdFoil = foil ? parsedPrice : 0;

    const query = {
      cardName,
      set,
      condition,
      foil: !!foil,
      variantType
    };

    console.log('🧩 Inventory check query:', query);
    console.log('🧬 Incoming meta:', {
      colors: incomingColors,
      cardType: incomingCardType,
      creatureTypes: incomingCreatureTypes
    });

    const existingCard = await CardInventory.findOne(query);

    if (existingCard) {
      existingCard.quantity += parseInt(quantity, 10) || 0;
      existingCard.priceUsd = priceUsd;
      existingCard.priceUsdFoil = priceUsdFoil;
      existingCard.imageUrl = imageUrl;

      existingCard.colors = incomingColors;
      existingCard.cardType = incomingCardType;
      existingCard.creatureTypes = incomingCreatureTypes;

      await existingCard.save();
      return res.status(200).json({ message: 'Card updated in inventory!' });
    } else {
      const newCard = new CardInventory({
        ...query,
        quantity: parseInt(quantity, 10) || 0,
        priceUsd,
        priceUsdFoil,
        imageUrl,
        colors: incomingColors,
        cardType: incomingCardType,
        creatureTypes: incomingCreatureTypes
      });

      await newCard.save();
      return res.status(201).json({ message: 'Card added to inventory!' });
    }
  } catch (err) {
    console.error('❌ Add inventory error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.post('/api/tradein', async (req, res) => {
  const { userId, cards, estimatedValue, source, notes } = req.body;

  if (!userId || !Array.isArray(cards) || cards.length === 0) {
    return res.status(400).json({ message: 'Invalid trade-in data.' });
  }

  try {
    const user = await User.findById(userId).lean();
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const totalCards = cards.reduce(
      (sum, c) => sum + (typeof c.quantity === 'number' ? c.quantity : 1),
      0
    );

    const tradeInData = {
      userId,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      phone: user.phone,
      cards,
      estimatedValue: typeof estimatedValue === 'number' ? estimatedValue : undefined,
      totalCards,
      source: source || 'Website Trade-In',
      notes: notes || '',
      status: 'New'
    };

    await new TradeIn(tradeInData).save();
    res.status(201).json({ message: '🧾 Trade-in submitted successfully!' });
  } catch (err) {
    console.error('❌ Trade-in submission error:', err);
    res.status(500).json({ message: 'Server error while submitting trade-in.' });
  }
});

// List all incoming collections (for admin dashboard)
app.get('/api/collections', async (req, res) => {
  try {
    const collections = await TradeIn.find().sort({ submittedAt: -1 });
    res.json(collections);
  } catch (err) {
    console.error('❌ Error fetching collections:', err);
    res.status(500).json({ message: 'Server error while fetching collections.' });
  }
});

// Update a single collection (status, internal notes, etc.)
app.patch('/api/collections/:id', async (req, res) => {
  const { id } = req.params;
  const { status, internalNotes, estimatedValue, totalCards, source, notes } = req.body;

  try {
    const update = {};

    if (typeof status === 'string') update.status = status;
    if (typeof internalNotes === 'string') update.internalNotes = internalNotes;
    if (typeof notes === 'string') update.notes = notes;
    if (typeof source === 'string') update.source = source;
    if (typeof estimatedValue === 'number') update.estimatedValue = estimatedValue;
    if (typeof totalCards === 'number') update.totalCards = totalCards;

    const updated = await TradeIn.findByIdAndUpdate(id, update, { new: true });

    if (!updated) {
      return res.status(404).json({ message: 'Collection not found.' });
    }

    res.json({ message: 'Collection updated.', collection: updated });
  } catch (err) {
    console.error('❌ Error updating collection:', err);
    res.status(500).json({ message: 'Server error while updating collection.' });
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
      variantType: 1,
      addedAt: 1
    }).sort({ cardName: 1 });

    res.json(cards);
  } catch (err) {
    console.error('❌ Fetch inventory error:', err);
    res.status(500).json({ message: 'Internal server error.' });
  }
});

app.delete('/api/inventory/clear', async (req, res) => {
  try {
    const result = await CardInventory.deleteMany({});
    res.json({
      message: 'Inventory cleared',
      deletedCount: result.deletedCount || 0
    });
  } catch (err) {
    console.error('❌ Clear inventory error:', err);
    res.status(500).json({ message: 'Failed to clear inventory' });
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

app.patch('/api/inventory/update-price', async (req, res) => {
  const { cardName, set, foil, newPrice, variantType } = req.body;

  const parsedPrice = parseFloat(newPrice);
  if (!cardName || !set || isNaN(parsedPrice)) {
    return res.status(400).json({ message: 'Missing or invalid required fields.' });
  }

  try {
    const fieldToUpdate = foil ? 'priceUsdFoil' : 'priceUsd';

    const query = {
      cardName,
      set,
      foil: !!foil,
      variantType: (variantType || '').trim().toLowerCase()
    };

    console.log('🔍 Update price request:', { cardName, set, foil, newPrice, variantType });
    console.log('🧩 MongoDB query:', query);

    const updated = await CardInventory.findOneAndUpdate(
      query,
      { [fieldToUpdate]: parsedPrice },
      { new: true }
    );

    if (!updated) {
      console.warn('⚠️ No matching card found for update:', query);
      return res.status(404).json({ message: 'Card not found.' });
    }

    res.json({ message: 'Price updated.', updated });
  } catch (err) {
    console.error('❌ Update price error:', err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.post('/api/inventory/prices', async (req, res) => {
  try {
    const { cards } = req.body;
    if (!Array.isArray(cards)) return res.status(400).json({ error: 'Cards array required.' });

    const prices = {};
    const normalize = str => str?.toLowerCase().trim().replace(/\s+/g, ' ') || '';

    for (const { cardName, set, foil } of cards) {
      if (!cardName || !set) continue;

      let match = await CardInventory.findOne({ cardName, set, foil: !!foil });

      if (!match) {
        match = await CardInventory.findOne({
          cardName: { $regex: `^${cardName}$`, $options: 'i' },
          set: { $regex: `^${set}$`, $options: 'i' },
          foil: !!foil
        });
      }

      if (match) {
        const key = `${normalize(cardName)}|${normalize(set)}|${foil ? '1' : '0'}`;
        let rawPrice = foil ? match.priceUsdFoil : match.priceUsd;
        if (rawPrice == null && match.price != null) {
          rawPrice = match.price;
        }
        prices[key] = parseFloat(rawPrice) || 0;
      }
    }

    res.json(prices);
  } catch (err) {
    console.error('❌ Batch prices error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/orders', async (req, res) => {
  console.log('🧾 Incoming order data:', req.body);

 const {
  userId, firstName, lastName, email, address, cards,
  shippingMethod, paymentMethod, orderTotal,
  stripePaymentIntentId, paymentStatus
} = req.body;

  if (!userId || !firstName || !lastName || !email || !address || !Array.isArray(cards)) {
    return res.status(400).json({ message: 'Missing required fields in order.' });
  }

  if (cards.length === 0) {
    return res.status(400).json({ message: 'Order must contain at least one card.' });
  }

  for (const [i, item] of cards.entries()) {
    if (!item.cardName || !item.set || !item.condition || typeof item.quantity !== 'number') {
      console.warn(`⚠️ Invalid card at index ${i}:`, item);
      return res.status(400).json({ message: `Invalid card data at index ${i}.` });
    }
  }

  try {
    const parsedOrderTotal = parseFloat(orderTotal);
    const newOrder = new Order({
      userId,
      firstName,
      lastName,
      email,
      address,
      cards,
      shippingMethod,
      paymentMethod,

      // ✅ save Stripe info
      stripePaymentIntentId: stripePaymentIntentId || null,
      paymentStatus: paymentStatus || (paymentMethod === 'card' ? 'paid' : 'unpaid'),

      orderTotal: isNaN(parsedOrderTotal) ? 0 : parsedOrderTotal,
      status: req.body.status || 'Pending'
    });

    const savedOrder = await newOrder.save();

    for (const item of cards) {
      const parsedPrice = parseFloat(item.priceUsd);
      item.priceUsd = !isNaN(parsedPrice) ? parseFloat(parsedPrice.toFixed(2)) : 0;

      const match = await CardInventory.findOne({
        cardName: item.cardName,
        set: item.set,
        foil: !!item.foil,
        condition: item.condition
      });

      if (!match) {
        console.warn(`⚠️ No match found in inventory for: ${item.cardName} (${item.set})`);
        continue;
      }

      if (match.quantity < item.quantity) {
        return res.status(400).json({
          message: `Not enough stock for ${item.cardName}. Available: ${match.quantity}, Requested: ${item.quantity}`
        });
      }

      const parsedMatchPrice = parseFloat(match.priceUsd);
      const parsedMatchFoilPrice = parseFloat(match.priceUsdFoil);
      match.priceUsd = !isNaN(parsedMatchPrice) ? parsedMatchPrice : 0;
      match.priceUsdFoil = !isNaN(parsedMatchFoilPrice) ? parsedMatchFoilPrice : 0;

      match.quantity -= item.quantity;

      if (match.quantity <= 0) {
        await CardInventory.deleteOne({ _id: match._id });
      } else {
        await match.save();
      }
    }

    await Cart.findOneAndUpdate(
      { userId },
      { items: [], updatedAt: new Date() }
    );

    res.status(201).json(savedOrder);
  } catch (err) {
    console.error('❌ Error saving order:', err.stack || err);
    res.status(500).json({ message: 'Server error while saving order.' });
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
  console.log('🛠️ PATCH /api/inventory/decrement called with:', req.body);

  try {
    const { cardName, set, foil, variantType, colors = [], cardType = '', creatureTypes = [] } = req.body;

    if (!cardName || !set) {
      return res.status(400).json({ message: 'Missing cardName or set.' });
    }

    const variantKey = (variantType || '').trim().toLowerCase();

    const exactQuery = {
      cardName,
      set,
      foil: !!foil,
      variantType: variantKey,
      colors: { $all: colors },
      cardType,
      creatureTypes: { $all: creatureTypes }
    };

    let card = await CardInventory.findOne(exactQuery);

    if (!card) {
      card = await CardInventory.findOne({
        cardName,
        set,
        foil: !!foil,
        $or: [
          { variantType: { $exists: false } },
          { variantType: '' },
          { variantType: null },
          { variantType: { $regex: `^${variantKey}$`, $options: 'i' } }
        ]
      });
    }

    if (!card) {
      console.warn('⚠️ Card not found for:', { cardName, set, foil, variantKey, colors, cardType, creatureTypes });
      return res.status(404).json({ message: 'Card not found.' });
    }

    if (card.quantity > 1) {
      card.quantity -= 1;
      await card.save();
      return res.status(200).json({ message: 'Quantity decremented.', card });
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

app.get('/api/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ submittedAt: -1 });
    res.json(orders);
  } catch (err) {
    console.error('❌ Error fetching orders:', err);
    res.status(500).json({ message: 'Server error while fetching orders.' });
  }
});

app.patch('/api/orders/:id/status', async (req, res) => {
  const { id } = req.params;
  const { status, trackingNumber } = req.body;

  try {
    const order = await Order.findById(id);
    if (!order) return res.status(404).json({ message: 'Order not found.' });

    if (status) {
      order.status = status;

      if (status.toLowerCase() === 'packing') {
        order.packedAt = new Date();
      }

      if (status.toLowerCase() === 'dropped off') {
        order.droppedOffAt = new Date();
      }
    }
    if (trackingNumber) order.trackingNumber = trackingNumber;
    await order.save();

    const user = await User.findById(order.userId);
    if (!user) {
      console.warn('⚠️ User not found for order.userId:', order.userId);
      return res.json({ message: 'Order updated, but user not found.' });
    }

    if (user?.shippingNotifications?.enabled) {
      const message = `📦 Your Geega Games order is now: ${status}` +
        (trackingNumber ? ` (Tracking #: ${trackingNumber})` : '');

      try {
        if (user.shippingNotifications.byEmail && user.email) {
          console.log('📧 Sending email to', user.email);
          await transporter.sendMail({
            from: `"Geega Games" <${process.env.NOTIFY_EMAIL}>`,
            to: user.email,
            subject: '🧙 Order Status Update',
            text: message
          });
        }

        if (user.shippingNotifications.byText && user.phone) {
          const formattedPhone = user.phone.startsWith('+') ? user.phone : `+1${user.phone}`;
          console.log('📱 Sending SMS to', formattedPhone);
          await twilioClient.messages.create({
            body: message,
            from: process.env.TWILIO_PHONE,
            to: formattedPhone
          });
        }
      } catch (notifyErr) {
        console.error('❌ Notification error:', notifyErr.message);
      }
    }

    res.json({ message: 'Order updated and notification (if enabled) sent.', order });
  } catch (err) {
    console.error('❌ Order update error:', err.stack || err);
    res.status(500).json({ message: 'Server error.' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch (err) {
    console.error('❌ Error fetching order by ID:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/upload-card-image', upload.single('cardImage'), async (req, res) => {
  const imagePath = path.resolve(req.file.path);

  async function sliceIntoCards(filePath) {
    const image = sharp(filePath);
    const { width, height } = await image.metadata();
    console.log(`📏 Image size: ${width} x ${height}`);

    if (!width || !height || width < 900 || height < 900) {
      throw new Error(`Image too small to slice: ${width}x${height} (min: 900x900 for 3x3 binder layout)`);
    }

    const cols = 3;
    const rows = 3;
    const cardWidth = Math.floor(width / cols);
    const cardHeight = Math.floor(height / rows);

    const cardPaths = [];

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const left = col * cardWidth;
        const top = row * cardHeight;
        const cropWidth = (col === cols - 1) ? width - left : cardWidth;
        const cropHeight = (row === rows - 1) ? height - top : cardHeight;

        const outputPath = `${filePath}-slice-${row}-${col}.png`;

        try {
          await image
            .extract({ left, top, width: cropWidth, height: cropHeight })
            .toFile(outputPath);

          cardPaths.push(outputPath);
        } catch (err) {
          console.warn(`⚠️ Skipped invalid slice (${row},${col}): ${err.message}`);
        }
      }
    }

    return cardPaths;
  }

  try {
    const slicedPaths = await sliceIntoCards(imagePath);
    const results = [];

    for (const slice of slicedPaths) {
      try {
        console.log(`🔍 OCR on: ${slice}`);
        const { data: { text } } = await Tesseract.recognize(slice, 'eng');
        console.log(`🧠 OCR text:\n${text}`);

        const lines = text
          .split('\n')
          .map(l => l.trim())
          .filter(l => l.length >= 2);

        for (const line of lines) {
          try {
            console.log(`🔗 Trying Scryfall for: "${line}"`);
            const response = await axios.get(`https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(line)}`);
            const card = response.data;

            results.push({
              input: line,
              matchedCard: card.name,
              set: card.set_name,
              image: card.image_uris?.normal || '',
              price: card.prices.usd || 'N/A',
            });
            break;
          } catch (err) {
            console.warn(`❌ No match on Scryfall for "${line}"`);
          }
        }
      } catch (err) {
        console.warn(`⚠️ OCR or parsing failed on ${slice}: ${err.message}`);
      } finally {
        if (fs.existsSync(slice)) fs.unlinkSync(slice);
      }
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'No cards recognized. Try a clearer photo of your binder page.' });
    }

    res.json({ count: results.length, cards: results });
  } catch (err) {
    console.error('❌ Full processing error:', err.message || err);
    res.status(500).json({ error: 'Could not process image or fetch card data.' });
  } finally {
    if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
  }
});

app.get('/api/track-usps/:trackingNumber', async (req, res) => {
  const { trackingNumber } = req.params;
  const uspsUserID = process.env.USPS_USER_ID;
  const debug = req.query.debug === 'true';

  const xml = `
    <TrackFieldRequest USERID="${uspsUserID}">
      <TrackID ID="${trackingNumber}"></TrackID>
    </TrackFieldRequest>
  `.trim();

  try {
    const uspsRes = await axios.get('https://secure.shippingapis.com/ShippingAPI.dll', {
      params: { API: 'TrackV2', XML: xml },
    });

    const parsed = await parser.parseStringPromise(uspsRes.data);
    const trackInfo = parsed?.TrackResponse?.TrackInfo?.[0];

    if (debug) {
      console.log('📦 FULL USPS RESPONSE:');
      console.dir(trackInfo, { depth: null });
      return res.json(trackInfo);
    }

    const summary = trackInfo?.TrackSummary?.[0];
    const details = Array.isArray(trackInfo?.TrackDetail) ? trackInfo.TrackDetail[0] : null;

    const statusText = summary || details || 'Tracking info not yet available';
    const dateMatch = statusText.match(/on (.*?)\./i);
    const dateText = dateMatch ? dateMatch[1] : 'N/A';

    res.json({
      status: statusText.split(',')[0],
      date: dateText,
    });
  } catch (err) {
    console.error('❌ USPS tracking parse error:', err.message || err);
    res.status(500).json({ status: 'Error', date: '' });
  }
});

app.get("/api/scan-jobs", async (req, res) => {
  const status = (req.query.status || "").trim();
  const q = status ? { status } : {};
  const jobs = await ScanJob.find(q).sort({ createdAt: -1 }).limit(200).lean();
  res.json(jobs);
});

app.get("/api/scan-jobs/:id", async (req, res) => {
  const job = await ScanJob.findById(req.params.id).lean();
  if (!job) return res.status(404).send("Not found");
  res.json(job);
});

app.post('/api/shippo/label', async (req, res) => {
  try {
    const shippo = await getShippo();
    console.log('✅ Shippo loaded:', typeof shippo, Object.keys(shippo));

    const { addressFrom, addressTo, parcel } = req.body;

    const shipment = await shippo.shipment.create({
      address_from: addressFrom,
      address_to: addressTo,
      parcels: [parcel],
      async: false
    });

    const rate = shipment.rates.find(r => r.provider === 'USPS');
    if (!rate) return res.status(400).json({ message: 'No USPS rate found.' });

    const label = await shippo.transaction.create({
      rate: rate.object_id,
      label_file_type: 'PDF'
    });

    console.log('📨 Full label response:', label);

    const labelUrl = label.label_url || label.label_pdf_url;

    if (!labelUrl) {
      return res.status(500).json({
        message: 'Label creation failed — no label URL returned.',
        error: label.messages || 'Missing label_url and label_pdf_url.'
      });
    }

    res.json({
      labelUrl,
      trackingNumber: label.tracking_number
    });
  } catch (err) {
    console.error('❌ Shippo label error:', err.response?.data || err.stack || err);
    res.status(500).json({
      message: 'Failed to generate label',
      error: err.response?.data?.error || err.message || 'Unknown error'
    });
  }
});

// ✅ Add this to server.js near other routes
app.get('/api/send-email-optin', async (req, res) => {
  try {
    const users = await User.find({
      'announcementNotifications.enabled': { $ne: true }
    });

    for (const user of users) {
      const baseUrl = 'https://www.geega-games.com/api/email-opt-in';
      const yesUrl = `${baseUrl}?email=${encodeURIComponent(user.email)}&response=yes`;
      const noUrl = `${baseUrl}?email=${encodeURIComponent(user.email)}&response=no`;

      const html = `
        <p>Hi ${user.firstName || 'there'},</p>
        <p>Would you like to receive occasional updates about new inventory, deals, and Geega Games news?</p>
        <p><a href="${yesUrl}">✅ Yes, sign me up!</a></p>
        <p><a href="${noUrl}">❌ No thanks</a></p>
      `;

      await transporter.sendMail({
        from: `Geega Games <${process.env.NOTIFY_EMAIL}>`,
        to: user.email,
        subject: 'Want Geega Games Updates?',
        html
      });
    }

    res.json({ message: `Opt-in emails sent to ${users.length} users.` });
  } catch (err) {
    console.error('❌ Email opt-in error:', err);
    res.status(500).json({ message: 'Failed to send opt-in emails' });
  }
});

app.get('/api/manual-update-optin', async (req, res) => {
  const updates = [
    'godlyalert@gmail.com',
    'joseguerrero411@yahoo.com',
    'femdymere@gmail.com',
    'scott.dyvig@gmail.com',
    'mak091901@gmail.com',
    'Espurg03@yahoo.com',
    'jwgarfield82@gmail.com',
    'nienlam547@gmail.com',
    'scottyhayward12221@gmail.com',
    'haywardscotty9@gmail.com',
    'brumfield61@yahoo.com'
  ];

  try {
    const result = await Promise.all(
      updates.map(email =>
        User.findOneAndUpdate(
          { email },
          {
            announcementNotifications: {
              enabled: true,
              byEmail: true,
              byText: true
            }
          },
          { new: true }
        )
      )
    );

    const updated = result.filter(r => r);
    res.send(`✅ Updated ${updated.length} user(s).`);
  } catch (err) {
    console.error('❌ Manual update error:', err);
    res.status(500).send('Failed to update users.');
  }
});

const SCAN_WORKERS = Number(process.env.SCAN_WORKERS || 2); // keep 1-3
const SCAN_MAX_ATTEMPTS = Number(process.env.SCAN_MAX_ATTEMPTS || 5);
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

let scanInFlight = 0;

async function claimNextScanJob() {
  const lockExpired = new Date(Date.now() - LOCK_TIMEOUT_MS);

  return ScanJob.findOneAndUpdate(
    {
      status: { $in: ["queued", "processing"] },
      $or: [
        { status: "queued" },
        { status: "processing", lockedAt: { $lt: lockExpired } }
      ]
    },
    {
      $set: { status: "processing", lockedAt: new Date() },
      $inc: { attempts: 1 }
    },
    { sort: { createdAt: 1 }, new: true }
  );
}

async function scanWorkerTick() {
  while (scanInFlight < SCAN_WORKERS) {
    const job = await claimNextScanJob();
    if (!job) break;

    scanInFlight++;

    (async () => {
      try {
        const result = await processSingleScanToInventory({
          filePath: job.filePath,
          originalName: job.originalName,
          condition: job.condition,
          foil: job.foil,
          setCode: job.setCode
        });

        job.status = "done";
        job.finishedAt = new Date();
        job.lastError = null;

        job.guessedName = result.guessedName;
        job.nameConfidence = result.nameConfidence;
        job.collectorNumber = result.collectorNumber;
        job.chosenSet = result.chosenSet;
        job.chosenSetName = result.chosenSetName;
        job.chosenCollector = result.chosenCollector;
        job.ocrTextBottom = result.ocrTextBottom;

        await job.save();
      } catch (e) {
        job.lastError = e?.message || String(e);

        if (job.attempts >= SCAN_MAX_ATTEMPTS) {
          job.status = "failed";
          job.finishedAt = new Date();
        } else {
          job.status = "queued";
        }

        await job.save();
      } finally {
        // cleanup original uploaded file
        try { if (job.filePath && fs.existsSync(job.filePath)) fs.unlinkSync(job.filePath); } catch {}

        scanInFlight--;
      }
    })();
  }
}

// Start worker loop
setInterval(() => {
  scanWorkerTick().catch(err => console.error("❌ scanWorkerTick:", err));
}, 1000);

// Start Server
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
