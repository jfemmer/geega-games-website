// server.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const cors = require('cors');
const axios = require('axios');
const crypto = require('crypto'); // ✅ NEW (email verification)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
console.log("Stripe key exists?", !!process.env.STRIPE_SECRET_KEY);
console.log("MONGODB_URI:", process.env.MONGODB_URI);
console.log("INVENTORY_DB_URI:", process.env.INVENTORY_DB_URI);
console.log("EMPLOYEE_DB_URI:", process.env.EMPLOYEE_DB_URI);
console.log("TRADEIN_DB_URI:", process.env.TRADEIN_DB_URI);
const { registerCropDebugRoutes } = require("./cropDebugViewer");


const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

if (!stripe) {
  console.warn("⚠️ Stripe disabled locally: STRIPE_SECRET_KEY is missing");
}

const app = express();

const sseClients = new Set();

function notifyReviewClients(payload = {}) {
  const data = JSON.stringify({ type: "review_updated", ts: Date.now(), ...payload });
  for (const res of sseClients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

// 🆕 NEW: Multer + Tesseract
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const {
  ocrCardNameHighAccuracy,
  ocrCollectorNumberHighAccuracy,
  ocrSetCodeHighAccuracy,
  findBestLocalMatches,
  computeOverallScore,
  shouldAutoIngest,
  enqueueForReview,
  detectSetSymbol,
  ensureSetSymbolCache
} = require("./ocr");

let findBestNameMatches = null;
let findExactPrinting = null;

if (process.env.USE_LOCAL === "true") {
  ({ findBestNameMatches, findExactPrinting } = require("./ocr/localCardIndex"));
}


const uspsUserID = process.env.USPS_USER_ID;
const getShippo = require('./shippo-wrapper');

const UPLOAD_DIR = path.join(__dirname, "uploads");

const LOCAL_IMAGE_DIR =
  process.env.LOCAL_IMAGE_DIR || "D:/MTG_DATA/images/normal";

app.use("/local_card_images", express.static(LOCAL_IMAGE_DIR));

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const OCR_DEBUG_DIR = path.join(__dirname, "ocr_debug");
if (!fs.existsSync(OCR_DEBUG_DIR)) {
  fs.mkdirSync(OCR_DEBUG_DIR, { recursive: true });
}

const inFlightUploads = new Set();

if (process.env.USE_LOCAL === "true") {
  ensureSetSymbolCache().then((data) => {
    console.log("🧩 Set symbol cache ready", { count: data?.entries?.length || 0 });
  }).catch((err) => {
    console.log("⚠️ Set symbol cache warmup failed:", err.message);
  });
}

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 5   // good idea to limit
  }
});

// -------------------- Inventory Review Queue Helpers --------------------
const REVIEW_QUEUE_PATH =
  process.env.REVIEW_QUEUE_PATH ||
  path.join(__dirname, "review_queue", "inventory-review.jsonl");

const REVIEW_IMAGE_DIR = path.join(__dirname, "review_uploads");

if (!fs.existsSync(REVIEW_IMAGE_DIR)) {
  fs.mkdirSync(REVIEW_IMAGE_DIR, { recursive: true });
}

app.use("/review_uploads", express.static(REVIEW_IMAGE_DIR));

function ensureDirSafe(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function safeJsonParse(line) {
  try { return JSON.parse(line); } catch { return null; }
}

function makeReviewItemId(item, index) {
  const raw = [
    item?.ts || "",
    item?.file || "",
    item?.reason || "",
    item?.originalImagePath || "",
    item?.guessedName || "",
    String(index)
  ].join("|");

  return crypto.createHash("sha1").update(raw).digest("hex");
}

function readReviewQueue(queuePath = REVIEW_QUEUE_PATH) {
  try {
    if (!fs.existsSync(queuePath)) return [];
    const raw = fs.readFileSync(queuePath, "utf8");
    return raw
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean)
      .map(safeJsonParse)
      .filter(Boolean)
      .map((item, index) => ({
        ...item,
        _id: makeReviewItemId(item, index)
      }));
  } catch (err) {
    console.error("❌ Failed reading review queue:", err.message);
    return [];
  }
}

function writeReviewQueue(items, queuePath = REVIEW_QUEUE_PATH) {
  try {
    ensureDirSafe(path.dirname(queuePath));
    const lines = items.map(({ _id, ...rest }) => JSON.stringify(rest)).join("\n");
    fs.writeFileSync(queuePath, lines ? `${lines}\n` : "", "utf8");
    return true;
  } catch (err) {
    console.error("❌ Failed writing review queue:", err.message);
    return false;
  }
}

function preserveReviewImage(srcPath, originalName = "scan.png") {
  try {
    if (!srcPath || !fs.existsSync(srcPath)) {
      return { absPath: "", publicUrl: "", filename: "" };
    }

    ensureDirSafe(REVIEW_IMAGE_DIR);

    const ext = path.extname(originalName || srcPath) || path.extname(srcPath) || ".png";
    const base = path.basename(originalName || "scan", path.extname(originalName || "scan"));
    const safeBase = String(base).replace(/[^a-zA-Z0-9_-]/g, "_");
    const filename = `${Date.now()}_${safeBase}${ext}`;
    const dest = path.join(REVIEW_IMAGE_DIR, filename);

    console.log("🖼️ Preserving review image:", {
      srcPath,
      originalName
    });

    fs.copyFileSync(srcPath, dest);

    return {
      absPath: dest,
      publicUrl: `/review_uploads/${filename}`,
      filename
    };
  } catch (err) {
    console.error("❌ Failed preserving review image:", err.message);
    return { absPath: "", publicUrl: "", filename: "" };
  }
}

function makeReviewHash({
  file = "",
  reason = "",
  guessedName = "",
  collectorNumber = "",
  condition = "",
  foil = false
}) {
  const raw = [
    String(file || "").trim().toLowerCase(),
    String(reason || "").trim().toLowerCase(),
    String(guessedName || "").trim().toLowerCase(),
    String(collectorNumber || "").trim().toLowerCase(),
    String(condition || "").trim().toLowerCase(),
    String(foil)
  ].join("|");

  return crypto.createHash("sha1").update(raw).digest("hex");
}

function queueReviewRecord(record) {
  const withHash = {
    ...record,
    reviewHash:
      record?.reviewHash ||
      makeReviewHash({
        file: record?.file,
        reason: record?.reason,
        guessedName: record?.guessedName,
        collectorNumber:
          record?.collector?.collectorNumber ||
          record?.chosen?.collector_number ||
          "",
        condition: record?.condition,
        foil: record?.foil
      })
  };

  return enqueueForReview(withHash, REVIEW_QUEUE_PATH);
}

function removeReviewItemById(id, queuePath = REVIEW_QUEUE_PATH) {
  const items = readReviewQueue(queuePath);
  const idx = items.findIndex(item => item._id === id);
  if (idx === -1) return null;

  const [removed] = items.splice(idx, 1);
  const ok = writeReviewQueue(items, queuePath);
  return ok ? removed : null;
}

function findReviewItemById(id, queuePath = REVIEW_QUEUE_PATH) {
  const items = readReviewQueue(queuePath);
  return items.find(item => item._id === id) || null;
}

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
  allowedHeaders: ['Content-Type','Authorization','x-ingest-key'],
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));



async function sendVerificationEmail({ toEmail, firstName, verifyUrl }) {
  // ✅ Safety: make sure it's a full URL (clickable in clients)
  const safeUrl = String(verifyUrl || "").trim();

  const html = `
  <div style="font-family: Arial, sans-serif; line-height: 1.5; color:#222;">
    <h2 style="margin:0 0 12px 0; color:#663399;">Verify your email</h2>
    <p style="margin:0 0 12px 0;">Hey ${firstName || "there"} 👋</p>
    <p style="margin:0 0 16px 0;">
      Thanks for signing up for Geega Games! Click the button below to verify your email.
    </p>

    <!-- ✅ Email-client-safe button (table layout) -->
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 0 0 16px 0;">
      <tr>
        <td bgcolor="#663399" style="border-radius: 10px;">
          <a href="${safeUrl}" target="_blank" rel="noopener noreferrer"
             style="display:inline-block; padding:12px 18px; font-weight:700; color:#ffffff; text-decoration:none; border-radius:10px;">
            Verify Email
          </a>
        </td>
      </tr>
    </table>

    <!-- ✅ Fallback: visible clickable link if button styling is stripped -->
    <p style="margin:0 0 6px 0; font-size: 13px; color:#555;">
      If the button doesn’t work, copy and paste this link into your browser:
    </p>
    <p style="margin:0 0 16px 0; font-size: 13px; word-break: break-all;">
      <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="color:#663399;">
        ${safeUrl}
      </a>
    </p>

    <p style="margin:0; font-size:12px; color:#777;">
      If you didn’t create an account, you can ignore this email.
    </p>
  </div>
  `;

  const text =
`Verify your email for Geega Games

Hey ${firstName || "there"},

Open this link to verify your email:
${safeUrl}

If you didn’t create an account, you can ignore this email.`;

  // ✅ Helpful debug (temporary): verifyUrl should never be empty
  console.log("📨 Verification email URL:", safeUrl);

  await transporter.sendMail({
    from: `Geega Games <${process.env.NOTIFY_EMAIL}>`,
    to: toEmail,
    subject: "Verify your Geega Games email",
    html,
    text, // ✅ ensures clickability even if client forces plain text
  });
}

// ---------- UPDATED ROUTE (FULL) ----------
// Assumes you already have:
// - upload (multer) configured
// - fs, path, axios imported
// - CardInventory model
// - ocrCardNameHighAccuracy(...) helper
// - ocrCollectorNumberHighAccuracy(...) helper (bottom-line OCR)
// - pickPrintingByCollector(...) helper (optional but recommended)
// Put these near the top of server.js (once)

app.post("/api/fi8170/scan-to-inventory", upload.array("cardImages"), async (req, res) => {
  if (process.env.USE_LOCAL !== "true") {
    return res.status(503).json({ error: "Local scan pipeline is disabled on this environment." });
  }

  const started = Date.now();
  const reqId = `fi8170_${Date.now()}_${Math.random().toString(16).slice(2)}`;

  try {
    const { condition, foil } = req.body;
    const files = req.files;

    console.log("📥 [fi8170] HIT", {
      reqId,
      time: new Date().toISOString(),
      files: files?.length || 0,
      condition,
      foil,
      setCode: req.body?.setCode
    });

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No images uploaded.", reqId });
    }

    const isFoil = String(foil) === "true";
    const results = [];

    const tmpDir = process.env.RAILWAY_ENVIRONMENT ? "/tmp/uploads" : path.join(__dirname, "uploads");
    try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

    const setCodeFromBody = (req.body.setCode || "").trim().toLowerCase();

    const seen = new Set();
    const uniqueFiles = [];
    for (const f of files) {
      const key = `${f.originalname}:${f.size}`;
      if (seen.has(key)) continue;
      seen.add(key);
      uniqueFiles.push(f);
    }

    for (const file of uniqueFiles) {
      const perFileStart = Date.now();
      const originalPath = file.path;

      // ✅ NEW: immediately copy upload to review_uploads so it survives
      // the finally-block cleanup and can be viewed via /review_uploads/
      const debugCopyName = `debug_${Date.now()}_${file.originalname}.png`;
      const debugCopyPath = path.join(REVIEW_IMAGE_DIR, debugCopyName);
      try {
        fs.copyFileSync(originalPath, debugCopyPath);
        console.log("🖼️ [fi8170] debug copy saved:", `/review_uploads/${debugCopyName}`);
      } catch (e) {
        console.log("⚠️ [fi8170] could not save debug copy:", e.message);
      }

      try {
        console.log("🖼️ [fi8170] file start:", {
          reqId,
          originalname: file.originalname,
          path: file.path,
          size: file.size
        });

        // 1) OCR: Name
        console.log("🔤 [fi8170] OCR(name bar) start", { reqId, originalName: file.originalname, filePath: file.path });
        const nameRes = await ocrCardNameHighAccuracy(originalPath, tmpDir);

        const guessedName = nameRes?.name || "";
        const nameConf = nameRes?.confidence ?? 0;
        const nameErr = nameRes?.error || null;

        let resolvedName = guessedName;

        const localNameMatches =
          (process.env.USE_LOCAL === "true" && typeof findBestNameMatches === "function")
            ? findBestNameMatches(guessedName, 10)
            : [];

        if (localNameMatches.length > 0) {
          resolvedName = localNameMatches[0].name || guessedName;
        }

        console.log("🔤 [fi8170] OCR(name bar) done", {
          reqId,
          guessedName,
          nameConf: Math.round(nameConf),
          nameErr
        });

        if (!guessedName || guessedName.length < 3) {
          const preserved = preserveReviewImage(originalPath, file.originalname);
          const earlyScore = computeOverallScore?.({
            nameConfidence: nameConf,
            collectorConfidence: 0,
            hadCollector: false,
            matchCount: 999
          }) ?? 0;

          console.log("🚨 REVIEW ITEM CREATED", {
            file: file.originalname,
            reason: "name_not_detected",
            score: earlyScore,
            guessedName,
            preserved
          });

          queueReviewRecord({
            reqId,
            file: file.originalname,
            reason: "name_not_detected",
            originalImagePath: preserved.absPath,
            scanImageUrl: preserved.publicUrl,
            reviewImageName: preserved.filename,
            condition,
            foil: isFoil,
            guessedName: guessedName || "",
            score: earlyScore,
            name: nameRes,
            collector: null,
            chosen: null
          });
          notifyReviewClients();
        

          results.push({
            file: file.originalname,
            status: "review",
            error: "Could not detect card name from name bar.",
            nameErr,
            score: earlyScore,
            ms: Date.now() - perFileStart
          });
          continue;
        }

        // 2) OCR: Collector number
        console.log("🔢 [fi8170] OCR(bottom line) start", { reqId });
        const bottom = await ocrCollectorNumberHighAccuracy(originalPath, tmpDir);
        const setCodeOcrResult = await ocrSetCodeHighAccuracy(originalPath, tmpDir);
        const setCodeOcrValue  = setCodeOcrResult?.setCode || null;
        const setCodeCropUrl   = setCodeOcrResult?.debugCropPath
          ? `/ocr_debug/${path.basename(setCodeOcrResult.debugCropPath)}`
          : null;

        let collectorNumber = bottom?.collectorNumber || null;

        const allowedSetCodes =
          nameConf >= 70
            ? localNameMatches.map(c => c.set).filter(Boolean)
            : [];

        const symbolResult = await detectSetSymbol(originalPath, {
          allowedSetCodes
        });

        const detectedSetCode = symbolResult?.setCode || "";
        const symbolTrusted = !!detectedSetCode && (symbolResult?.score ?? 0) >= 0.68;

        const effectiveSetCode =
          setCodeFromBody ||
          (symbolTrusted ? detectedSetCode : "");

        console.log("🧩 [fi8170] Set symbol detection done", {
          detectedSetCode,
          symbolTrusted,
          effectiveSetCode,
          symbolScore: symbolResult?.score ?? 0,
          bestDist: symbolResult?.bestDist ?? null,
          top: symbolResult?.top?.slice(0, 3) || []
        });

        console.log("🔢 [fi8170] OCR(bottom line) done", {
          reqId,
          bottomText: bottom?.text || "",
          bottomConf: Math.round(bottom?.confidence ?? 0),
          collectorNumber
        });

        if (nameConf < 45) {
          const score = computeOverallScore?.({
            nameConfidence: nameConf,
            collectorConfidence: bottom?.confidence ?? 0,
            hadCollector: !!collectorNumber,
            matchCount: 999,
            setSymbolScore: symbolResult?.score ?? null
          }) ?? 0;

          const preserved = preserveReviewImage(originalPath, file.originalname);

          queueReviewRecord({
            reqId,
            file: file.originalname,
            reason: "low_name_confidence",
            originalImagePath: preserved.absPath,
            scanImageUrl: preserved.publicUrl,
            reviewImageName: preserved.filename,
            condition,
            foil: isFoil,
            guessedName,
            score,
            name: nameRes,
            collector: bottom,
            setCodeOcr: setCodeOcrResult,
            setCodeCropUrl,
            chosen: null,
            detectedSetCode: detectedSetCode || null,
            setSymbolScore: symbolResult?.score ?? null,
            setSymbolBestDist: symbolResult?.bestDist ?? null,
            setSymbolTop: symbolResult?.top || []
          });

          notifyReviewClients();

          results.push({
            file: file.originalname,
            status: "review",
            error: `Low OCR confidence (${Math.round(nameConf)}). Needs review.`,
            guessedName,
            bottomText: bottom?.text || null,
            bottomConf: Math.round(bottom?.confidence || 0),
            score,
            ms: Date.now() - perFileStart
          });
          continue;
        }

        // 3) Local whole-library image-first match
        console.log("🧠 [fi8170] local image-first match start", { reqId });

        let card = null;
        let matchCount = 999;
        let localMatchMeta = null;

        try {
          localMatchMeta = await findBestLocalMatches(originalPath, {
            guessedName: resolvedName || guessedName || "",
            collectorNumber: collectorNumber || "",
            detectedSetCode: effectiveSetCode || detectedSetCode || "",
            isFoil,
            limit: 25
          });

          const best = localMatchMeta?.chosen || null;
          const second = localMatchMeta?.second || null;
          const margin = localMatchMeta?.margin ?? 0;
          const pool = localMatchMeta?.pool || [];

          matchCount = pool.length;

          if (!best) {
            throw new Error("No local card selected from full-library image search.");
          }

          console.log("🧠 [fi8170] local image-first result", {
            reqId,
            bestName: best?.name,
            bestSet: best?.set,
            bestCollector: best?.collector_number,
            bestScore: best?._score,
            secondScore: second?._score ?? null,
            margin
          });

          const strongEnough = best._score >= 85 && margin >= 12;

          if (!strongEnough) {
            throw new Error(
              `Image match inconclusive: bestScore=${best?._score ?? 0}, margin=${margin}`
            );
          }

          card = best;

          if (card && !card.imageUrl && card.local_image) {
            const filename = path.basename(card.local_image);
            card.imageUrl = `/local_card_images/${filename}`;
          }
        } catch (err) {
          const score = computeOverallScore?.({
            nameConfidence: nameConf,
            collectorConfidence: bottom?.confidence ?? 0,
            hadCollector: !!collectorNumber,
            matchCount,
            setSymbolScore: symbolResult?.score ?? null
          }) ?? 0;

          const preserved = preserveReviewImage(originalPath, file.originalname);

          queueReviewRecord({
            reqId,
            file: file.originalname,
            reason: "image_match_failed",
            originalImagePath: preserved.absPath,
            scanImageUrl: preserved.publicUrl,
            reviewImageName: preserved.filename,
            condition,
            foil: isFoil,
            score,
            guessedName,
            name: nameRes,
            collector: bottom,
            setCodeOcr: setCodeOcrResult,
            setCodeCropUrl,
            chosen: null,
            topLocalCandidates: (localMatchMeta?.pool || []).slice(0, 5).map(c => ({
              id: c.id,
              name: c.name,
              set: c.set,
              set_name: c.set_name,
              collector_number: c.collector_number,
              imageUrl: c.imageUrl,
              score: c._score,
              distances: c._distances,
              reasons: c._reasons
            })),
            bestLocalMargin: localMatchMeta?.margin ?? null,
            details: err?.message || String(err)
          });

          notifyReviewClients();

          results.push({
            file: file.originalname,
            status: "review",
            error: `Scryfall lookup failed: ${guessedName}`,
            details: err?.message || String(err),
            score,
            ms: Date.now() - perFileStart
          });
          continue;
        }

        console.log("🧙 [fi8170] Scryfall chosen:", {
          reqId,
          name: card?.name,
          set: card?.set,
          set_name: card?.set_name,
          collector_number: card?.collector_number,
          matchCount
        });

        // 4) Compute overall score + confidence gate
        const score = computeOverallScore?.({
          nameConfidence: nameConf,
          collectorConfidence: bottom?.confidence ?? 0,
          hadCollector: !!collectorNumber,
          matchCount,
          setSymbolScore: symbolResult?.score ?? null
        }) ?? 0;

        console.log("✅ AUTO INGEST", {
          file: file.originalname,
          score,
          guessedName,
          nameConfidence: nameConf
        });

        if (!shouldAutoIngest?.(score)) {
          const preserved = preserveReviewImage(originalPath, file.originalname);

          queueReviewRecord({
            reqId,
            file: file.originalname,
            reason: "below_confidence_threshold",
            originalImagePath: preserved.absPath,
            scanImageUrl: preserved.publicUrl,
            reviewImageName: preserved.filename,
            condition,
            foil: isFoil,
            score,
            matchCount,
            guessedName,
            name: nameRes,
            collector: bottom,
            setCodeOcr: setCodeOcrResult,
            setCodeCropUrl,
            detectedSetCode: detectedSetCode || null,
            setSymbolScore: symbolResult?.score ?? null,
            setSymbolBestDist: symbolResult?.bestDist ?? null,
            setSymbolTop: symbolResult?.top || [],
            chosen: {
              name: card?.name,
              set: card?.set,
              set_name: card?.set_name,
              collector_number: card?.collector_number,
              imageUrl:
                card?.image_uris?.normal ||
                card?.card_faces?.[0]?.image_uris?.normal ||
                ""
            }
          });

          notifyReviewClients();

          results.push({
            file: file.originalname,
            status: "review",
            score,
            reason: "below_confidence_threshold",
            guessedName,
            nameConfidence: Math.round(nameConf),
            collectorNumber: collectorNumber || null,
            chosenSet: card?.set || null,
            chosenSetName: card?.set_name || null,
            chosenCollector: card?.collector_number || null,
            matchCount,
            ms: Date.now() - perFileStart
          });
          continue;
        }

        // 5) Queue for manual review (passed confidence gate)
        const preserved = preserveReviewImage(originalPath, file.originalname);

        queueReviewRecord({
          reqId,
          file: file.originalname,
          reason: "manual_review_required",
          originalImagePath: preserved.absPath,
          scanImageUrl: preserved.publicUrl,
          reviewImageName: preserved.filename,
          condition,
          foil: isFoil,
          score,
          matchCount,
          guessedName,
          name: nameRes,
          collector: bottom,
          setCodeOcr: setCodeOcrResult,
          setCodeCropUrl,
          detectedSetCode: detectedSetCode || null,
          setSymbolScore: symbolResult?.score ?? null,
          setSymbolBestDist: symbolResult?.bestDist ?? null,
          setSymbolTop: symbolResult?.top || [],
          chosen: {
            name: card?.name,
            set: card?.set,
            set_name: card?.set_name,
            collector_number: card?.collector_number,
            imageUrl:
              card?.imageUrl ||
              card?.image_uris?.normal ||
              card?.card_faces?.[0]?.image_uris?.normal ||
              (card?.local_image ? `/local_card_images/${path.basename(card.local_image)}` : "")
          }
        });
        
        notifyReviewClients();

        results.push({
          file: file.originalname,
          status: "review",
          reason: "manual_review_required",
          guessedName,
          nameConfidence: Math.round(nameConf),
          collectorNumber: collectorNumber || null,
          chosenSet: card?.set || null,
          chosenSetName: card?.set_name || null,
          chosenCollector: card?.collector_number || null,
          matchCount,
          score,
          ms: Date.now() - perFileStart
        });

        continue;

      } catch (err) {
        console.error("❌ [fi8170] per-file error:", {
          reqId,
          file: file?.originalname,
          message: err?.message || err
        });

        const preserved = preserveReviewImage(originalPath, file?.originalname);

        queueReviewRecord({
          reqId,
          file: file?.originalname,
          reason: "per_file_exception",
          originalImagePath: preserved.absPath,
          scanImageUrl: preserved.publicUrl,
          reviewImageName: preserved.filename,
          condition,
          foil: isFoil,
          details: err?.message || String(err),
          guessedName: (typeof guessedName !== "undefined" ? guessedName : ""), 
          name: (typeof nameRes !== "undefined" ? nameRes : null),
          collector: (typeof bottom !== "undefined" ? bottom : null),
          chosen: null
        });

        notifyReviewClients();

        results.push({
          file: file.originalname,
          status: "review",
          error: err?.message || "Unknown error",
          ms: Date.now() - perFileStart
        });
      } finally {
        //try { if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath); } catch {}
      }
    }

    console.log("✅ [fi8170] DONE", {
      reqId,
      ms: Date.now() - started,
      processed: uniqueFiles.length
    });

    return res.json({ reqId, results });

  } catch (err) {
    console.error("❌ [fi8170] route error:", { err });
    return res.status(500).json({ error: "Server error processing scans." });
  }
});

app.post('/webhook/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'Stripe is not configured locally.' });
  }

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
    detectedSetCode: String,
    setSymbolScore: Number,
    setSymbolBestDist: Number,

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

  // 🟣 Store Credit (keep in cents to avoid floating point issues)
  storeCreditCents: { type: Number, default: 0 },

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
  const scanId = `${Date.now()}_${path.basename(originalName || filePath)}`;
  const perFileStart = Date.now();
  const tmpDir = OCR_DEBUG_DIR;
  try { if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  const isFoil = !!foil;
  const setCodeFromBody = (setCode || "").trim().toLowerCase();
  const safeCondition = (condition || "NM").trim();

  let preservedReview = null;
  const ensureReviewImage = () => {
    if (preservedReview) return preservedReview;
    preservedReview = preserveReviewImage(filePath, originalName || "scan.png");
    return preservedReview;
  };

  // 1) OCR: name bar
  console.log("🔤 [scan-ingest] OCR(name bar) start", { originalName, filePath });
  const nameRes = await ocrCardNameHighAccuracy(filePath, tmpDir);
  const guessedName = nameRes?.name || "";
  const nameConf = nameRes?.confidence ?? 0;
  const nameErr = nameRes?.error || null;

  console.log("🔤 [scan-ingest] OCR(name bar) done", {
    guessedName,
    nameConf: Math.round(nameConf),
    nameErr
  });

  if (!guessedName || guessedName.length < 3) {
    const preserved = ensureReviewImage();

    queueReviewRecord({
      file: originalName || path.basename(filePath),
      reason: "name_not_detected",
      originalImagePath: preserved.absPath,
      scanImageUrl: preserved.publicUrl,
      reviewImageName: preserved.filename,
      condition: safeCondition,
      foil: isFoil,
      name: nameRes
    });
    notifyReviewClients();

    throw new Error("Could not detect card name from name bar. Sent to review.");
  }

  // 1b) Resolve name through Scryfall fuzzy
  let resolvedName = guessedName;
  try {
    const named = await axios.get(
      `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(guessedName)}`
    );
    resolvedName = named.data?.name || guessedName;
  } catch {
    resolvedName = guessedName;
  }

  // 2) OCR: bottom line
  console.log("🔢 [scan-ingest] OCR(bottom line) start");
  const bottom = await ocrCollectorNumberHighAccuracy(filePath, tmpDir);
  const setCodeOcrResult = await ocrSetCodeHighAccuracy(filePath, tmpDir);
  const setCodeOcrValue  = setCodeOcrResult?.setCode || null;
  const setCodeCropUrl   = setCodeOcrResult?.debugCropPath
    ? `/ocr_debug/${path.basename(setCodeOcrResult.debugCropPath)}`
    : null;

  let collectorNumber = bottom?.collectorNumber || null;
  if (collectorNumber && (bottom?.confidence ?? 0) < 45) {
    collectorNumber = null;
  }

  console.log("🔢 [scan-ingest] OCR(bottom line) done", {
    bottomText: bottom?.text || "",
    bottomConf: Math.round(bottom?.confidence || 0),
    collectorNumber
  });

  // 2b) Hash-based set symbol detection (Scryfall-backed)
  console.log("🧩 [scan-ingest]", scanId, "Set symbol detection start");

  let symbolResult = {
    setCode: null,
    score: 0,
    bestDist: 9999,
    top: []
  };

  try {
    if (typeof detectSetSymbol === "function") {
      symbolResult = await detectSetSymbol(filePath);
    }
  } catch (err) {
    console.log("⚠️ [scan-ingest] Set symbol detection failed:", err.message);
  }

  const detectedSetCode = (symbolResult?.setCode || "").trim().toLowerCase();
  const symbolTrusted = (symbolResult?.score ?? 0) >= 0.68;
  const effectiveSetCode = setCodeFromBody || (symbolTrusted ? detectedSetCode : "");

  console.log("🧩 [scan-ingest] Set symbol detection done", {
    detectedSetCode,
    symbolTrusted,
    effectiveSetCode,
    symbolScore: symbolResult?.score ?? 0,
    bestDist: symbolResult?.bestDist ?? null,
    top: symbolResult?.top?.slice(0, 3) || []
  });

  // 3) Scryfall select printing
  console.log("🧙 [scan-ingest] Scryfall start", {
    guessedName,
    resolvedName,
    setCodeFromBody,
    detectedSetCode,
    effectiveSetCode,
    collectorNumber,
    isFoil
  });

  let base = null;
  let card = null;
  let matchCount = 999;

  try {
    const baseRes = await axios.get(
      `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(resolvedName)}`
    );
    base = baseRes.data;

    if (collectorNumber && effectiveSetCode) {
      const exactRes = await axios.get(
        `https://api.scryfall.com/cards/${encodeURIComponent(effectiveSetCode)}/${encodeURIComponent(collectorNumber)}`
      );
      card = exactRes.data;
      matchCount = 1;
    } else if (collectorNumber && base?.prints_search_uri && typeof pickPrintingByCollector === "function") {
      const meta = await pickPrintingByCollector(
        base.prints_search_uri,
        collectorNumber,
        isFoil,
        false,
        {
        returnMeta: true,
        setCode: effectiveSetCode || null
      }
      );

      let chosen = meta?.chosen || null;
      matchCount = meta?.matchCount ?? 999;
      const pool = meta?.pool || [];

      if (pool.length > 1 && typeof refineByArtworkHash === "function") {
        const hashResult = await refineByArtworkHash(filePath, pool, { maxDist: 8 });
        if (hashResult?.chosen) {
          chosen = hashResult.chosen;
          matchCount = 1;
        }
      }

      if (!chosen) {
        throw new Error(
          `Collector mismatch: OCR collector=${collectorNumber} did not match any printing for base="${base?.name}".`
        );
      }

      card = chosen;
    } else if (!collectorNumber && effectiveSetCode) {
      const query = `!"${resolvedName}" set:${effectiveSetCode}`;
      const s = await axios.get(
        `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`
      );
      card = s.data?.data?.[0] || base;
      matchCount = s.data?.data?.length || 999;
    } else {
      card = base;
      matchCount = 999;
    }

    if (!card) throw new Error("No Scryfall card selected");
  } catch (err) {
    const preserved = ensureReviewImage();

    console.log("🚨 [scan-ingest]", scanId, "Queueing review after symbol + Scryfall failure");

    queueReviewRecord({
      file: originalName || path.basename(filePath),
      reason: "scryfall_lookup_failed",
      originalImagePath: preserved.absPath,
      scanImageUrl: preserved.publicUrl,
      reviewImageName: preserved.filename,
      condition: safeCondition,
      foil: isFoil,
      guessedName,
      score: computeOverallScore({
        nameConfidence: nameConf,
        collectorConfidence: bottom?.confidence ?? 0,
        hadCollector: !!collectorNumber,
        matchCount,
        setSymbolScore: symbolResult?.score ?? null
      }),
      name: nameRes,
      collector: bottom,
      setCodeOcr: setCodeOcrResult,
      setCodeCropUrl,
      chosen: base ? {
        name: base?.name,
        set: base?.set,
        set_name: base?.set_name,
        collector_number: base?.collector_number,
        imageUrl: base?.image_uris?.normal || base?.card_faces?.[0]?.image_uris?.normal || ""
      } : null,
      detectedSetCode: detectedSetCode || null,
      setSymbolScore: symbolResult?.score ?? null,
      setSymbolBestDist: symbolResult?.bestDist ?? null,
      setSymbolTop: symbolResult?.top || [],
      details: err?.message || String(err)
    });

    notifyReviewClients();

    throw new Error(`Sent to review: ${err?.message || "Scryfall lookup failed"}`);
  }

  console.log("🧙 [scan-ingest] Scryfall chosen", {
    name: card?.name,
    set: card?.set,
    set_name: card?.set_name,
    collector_number: card?.collector_number,
    matchCount
  });

  // 4) Confidence gate
  const score = computeOverallScore({
    nameConfidence: nameConf,
    collectorConfidence: bottom?.confidence ?? 0,
    hadCollector: !!collectorNumber,
    matchCount,
    setSymbolScore: symbolResult?.score ?? null
  });

  if (!shouldAutoIngest(score)) {
    const preserved = ensureReviewImage();

    queueReviewRecord({
      file: originalName || path.basename(filePath),
      reason: "below_confidence_threshold",
      originalImagePath: preserved.absPath,
      scanImageUrl: preserved.publicUrl,
      reviewImageName: preserved.filename,
      condition: safeCondition,
      foil: isFoil,
      guessedName,
      score,
      name: nameRes,
      collector: bottom,
      setCodeOcr: setCodeOcrResult,
      setCodeCropUrl,
      chosen: {
        name: card?.name,
        set: card?.set,
        set_name: card?.set_name,
        collector_number: card?.collector_number,
        imageUrl: card?.image_uris?.normal || card?.card_faces?.[0]?.image_uris?.normal || ""
      },
      detectedSetCode: detectedSetCode || null,
      setSymbolScore: symbolResult?.score ?? null,
      setSymbolBestDist: symbolResult?.bestDist ?? null,
      setSymbolTop: symbolResult?.top || []
    });

    notifyReviewClients();

    throw new Error(`Sent to review: score ${score.toFixed(3)} below threshold`);
  }

  // 5) Save to inventory
  const price = isFoil
    ? parseFloat(card?.prices?.usd_foil || card?.prices?.usd || 0)
    : parseFloat(card?.prices?.usd || 0);

  const inventoryItem = {
    cardName: card.name,
    set: card.set_name,
    condition: safeCondition,
    foil: isFoil,
    priceUsd: price,
    imageUrl: card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || ""
  };

  console.log("💾 [scan-ingest] DB upsert start", {
    cardName: inventoryItem.cardName,
    set: inventoryItem.set,
    foil: inventoryItem.foil,
    condition: inventoryItem.condition
  });

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

  console.log("💾 [scan-ingest] DB upsert done");

  return {
    ms: Date.now() - perFileStart,
    guessedName,
    nameConfidence: Math.round(nameConf),
    collectorNumber,
    chosenSet: card?.set || null,
    chosenSetName: card?.set_name || null,
    chosenCollector: card?.collector_number || null,
    ocrTextName: null,
    ocrTextBottom: bottom?.text || null,
    detectedSetCode: detectedSetCode || null,
    setSymbolScore: symbolResult?.score ?? null,
    setSymbolBestDist: symbolResult?.bestDist ?? null
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
    const originalName = (req.body.originalName || req.file.originalname || "").trim();

    const recentCutoff = new Date(Date.now() - 15000);

    const existing = await ScanJob.findOne({
      originalName,
      createdAt: { $gte: recentCutoff },
      status: { $in: ["queued", "processing", "done"] }
    }).sort({ createdAt: -1 });

    if (existing) {
      console.log("⛔ Duplicate scan-ingest prevented:", {
        originalName,
        existingJobId: String(existing._id)
      });

      return res.json({
        jobId: String(existing._id),
        status: existing.status,
        deduped: true
      });
    }

    const job = await ScanJob.create({
      status: "queued",
      filePath: req.file.path,
      originalName,
      condition,
      foil,
      setCode
    });

    scanWorkerTick().catch(() => {});

    return res.json({ jobId: String(job._id), status: job.status });
  } catch (e) {
    console.error("❌ scan-ingest error:", e);
    if (!res.headersSent) {
      return res.status(500).json({ message: "Failed to ingest scan." });
    }
  }
});


// ⬇️ ADD THIS ROUTE WITH YOUR OTHER ROUTES
app.get("/api/inventory-review/stream", (req, res) => {
  const key = req.headers["x-ingest-key"] || req.query.key || "";
  if (key !== process.env.INGEST_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  res.write(`: connected\n\n`);

  sseClients.add(res);
  console.log(`📡 SSE client connected (total: ${sseClients.size})`);

  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat\n\n`); } catch {}
  }, 25000);

  req.on("close", () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
    console.log(`📡 SSE client disconnected (total: ${sseClients.size})`);
  });
});


// ✅ Routes

// Root
app.get('/', (req, res) => res.send('🧙‍♂️ Welcome to the Geega Games API!'));

// Version Check
app.get('/api/version-check', (req, res) => res.send('✅ Latest server.js version'));

app.get("/api/debug/upload/:filename", (req, res) => {
  const file = path.join(__dirname, "uploads", req.params.filename);
  if (!fs.existsSync(file)) return res.status(404).send("not found");
  res.set("Content-Type", "image/png");
  res.sendFile(file);
});

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
    return res.redirect(`${siteUrl}/login.html?verified=1&email=${encodeURIComponent(normalizedEmail)}`);
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
    const { userId, shippingMethod, storeCreditToApplyCents } = req.body;

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

      const variantKey = (item.variantType || '').trim().toLowerCase();

      const inv = await CardInventory.findOne({
        cardName: item.cardName,
        set: item.set,
        foil: !!item.foil,
        condition: item.condition,
        variantType: variantKey
      }).lean();

      // fallback if older rows have blank variantType
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
        return res.status(400).json({ error: `Invalid price for: ${item.cardName} (${item.set})` });
      }

      subtotal += unitPrice * qty;
    }

    // 3) Shipping rules
    let shippingCost = 0;
    if (method === 'tracked') {
      shippingCost = subtotal >= 75 ? 0 : 5;
    } else if (method === 'pwe') {
      shippingCost = 1.25;
    }

    const orderTotal = Number((subtotal + shippingCost).toFixed(2));
    const amountCents = Math.round(orderTotal * 100);

    const totalCents = amountCents;

    // 3.5) Optional: apply store credit (server-trusted)
    let creditRequested = Number(storeCreditToApplyCents || 0);
    if (!Number.isFinite(creditRequested)) creditRequested = 0;
    creditRequested = Math.max(0, Math.floor(creditRequested));

    let creditAvailable = 0;
    try {
      const user = await User.findById(userId).lean();
      creditAvailable = Math.max(0, Number(user?.storeCreditCents || 0));
    } catch {}

    const storeCreditAppliedCents = Math.min(creditRequested, creditAvailable, totalCents);
    const amountDueCents = Math.max(0, totalCents - storeCreditAppliedCents);

    // If store credit covers everything, no Stripe PaymentIntent needed
    if (amountDueCents === 0) {
      return res.json({
        clientSecret: null,
        orderTotal,
        paymentIntentId: null,
        storeCreditAppliedCents,
        amountDueCents
      });
    }

    // 4) Create PaymentIntent for remaining amount
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountDueCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: {
        userId: String(userId),
        shippingMethod: method,
        subtotal: subtotal.toFixed(2),
        shippingCost: shippingCost.toFixed(2),
        storeCreditAppliedCents: String(storeCreditAppliedCents),
        amountDueCents: String(amountDueCents),
        orderTotal: orderTotal.toFixed(2)
      }
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      orderTotal,
      paymentIntentId: paymentIntent.id,
      storeCreditAppliedCents,
      amountDueCents
    });
  } catch (error) {
    console.error('❌ Stripe create-payment-intent error:', error);
    res.status(500).json({ error: error.message || 'Stripe error' });
  }
});

// PATCH /api/users/:id/store-credit/add
// body: { amount: 10.00 }  // dollars
app.patch("/api/users/:id/store-credit/add", async (req, res) => {
  try {
    const { id } = req.params;
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ ok: false, message: "Invalid amount." });
    }

    const addCents = Math.round(amount * 100);

    const user = await User.findByIdAndUpdate(
      id,
      { $inc: { storeCreditCents: addCents } },
      { new: true }
    );

    if (!user) return res.status(404).json({ ok: false, message: "User not found." });

    return res.json({ ok: true, user });
  } catch (err) {
    console.error("store credit add error:", err);
    res.status(500).json({ ok: false, message: "Server error." });
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
      city,
      state,
      zip,
      announcementNotifications,
      shippingNotifications
    } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ message: 'Missing required fields.' });
    }

    const normalizedEmail = String(email).toLowerCase().trim();

    const existing = await User.findOne({
      $or: [{ email: normalizedEmail }, { username }]
    });

    if (existing) {
      return res.status(409).json({ message: 'User already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    // ✅ Build full address string
    const fullAddress = [
      address,
      city,
      state,
      zip
    ]
      .filter(Boolean)
      .join(', ')
      .trim();

    // ✅ Create email verification token
    const { token, tokenHash, expires } = createEmailVerificationToken();

    await new User({
      firstName,
      lastName,
      username,
      email: normalizedEmail,
      password: hashedPassword,
      phone,
      // ✅ Save combined address
      address: fullAddress,
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

    const apiBase =
      process.env.API_BASE_URL ||
      'https://geega-games-website-production.up.railway.app';

    const verifyUrl = `${apiBase}/verify-email?token=${token}&email=${encodeURIComponent(normalizedEmail)}`;

    await sendVerificationEmail({
      toEmail: normalizedEmail,
      firstName,
      verifyUrl
    });

    res.status(201).json({
      message:
        '🐶 Welcome to the Pack! Check your email to verify your account before logging in.'
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
    const { address } = req.body;

    const updated = await User.findByIdAndUpdate(
      id,
      { address },
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
    userId,
    firstName,
    lastName,
    email,
    address,
    cards,
    shippingMethod,
    paymentMethod,
    orderTotal,
    stripePaymentIntentId,
    paymentStatus,
    storeCreditUsedCents // 🟣 NEW
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

  // 🟣 normalize store credit (cents)
  let creditToDeduct = Number(storeCreditUsedCents || 0);
  if (!Number.isFinite(creditToDeduct)) creditToDeduct = 0;
  creditToDeduct = Math.max(0, Math.floor(creditToDeduct));

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

      // 🟣 NEW
      storeCreditUsedCents: creditToDeduct,

      orderTotal: isNaN(parsedOrderTotal) ? 0 : parsedOrderTotal,
      status: req.body.status || 'Pending'
    });

    const savedOrder = await newOrder.save();

    // ✅ inventory decrement
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

    // 🟣 deduct store credit AFTER inventory decrement succeeds
    if (creditToDeduct > 0) {
      const updatedUser = await User.findOneAndUpdate(
        { _id: userId, storeCreditCents: { $gte: creditToDeduct } },
        { $inc: { storeCreditCents: -creditToDeduct } },
        { new: true }
      );

      if (!updatedUser) {
        // if credit changed (or wasn't enough), don't silently succeed
        return res.status(409).json({
          message: 'Store credit balance changed. Please refresh and try again.'
        });
      }
    }

    // ✅ clear cart
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

const SCAN_WORKERS      = Number(process.env.SCAN_WORKERS      || 2);
const SCAN_MAX_ATTEMPTS = Number(process.env.SCAN_MAX_ATTEMPTS || 5);
const LOCK_TIMEOUT_MS   = 5 * 60 * 1000; // 5 min stale-lock window
const WORKER_POLL_MS    = Number(process.env.SCAN_WORKER_POLL_MS || 2000); // safety net only

let scanInFlight = 0;

// B7: Atomic job claim with stale-lock reclaim.
// Adds `lockedAt: { $lt: lockExpired }` to recover jobs that were claimed by a
// crashed worker, preventing them from getting stuck in "processing" forever.
// Recommendation: add a MongoDB index in your shell:
//   db.scanjobs.createIndex({ status: 1, createdAt: 1 })
async function claimNextScanJob() {
  const lockExpired = new Date(Date.now() - LOCK_TIMEOUT_MS);
 
  return ScanJob.findOneAndUpdate(
    {
      $or: [
        { status: "queued" },
        { status: "processing", lockedAt: { $lt: lockExpired } },
      ],
    },
    {
      $set: { status: "processing", lockedAt: new Date() },
      $inc: { attempts: 1 },
    },
    { sort: { createdAt: 1 }, new: true }
  );
}
 
// B5: Non-polling worker tick — drain as many jobs as concurrency allows.
// Called both on a timer AND immediately when a job is enqueued.
async function scanWorkerTick() {
  while (scanInFlight < SCAN_WORKERS) {
    const job = await claimNextScanJob();
    if (!job) break;
 
    scanInFlight++;
 
    (async () => {
      try {
        const result = await processSingleScanToInventory({
          filePath:     job.filePath,
          originalName: job.originalName,
          condition:    job.condition,
          foil:         job.foil,
          setCode:      job.setCode,
        });
 
        job.status        = "done";
        job.finishedAt    = new Date();
        job.lastError     = null;
        job.guessedName   = result.guessedName;
        job.nameConfidence= result.nameConfidence;
        job.collectorNumber=result.collectorNumber;
        job.chosenSet     = result.chosenSet;
        job.chosenSetName = result.chosenSetName;
        job.chosenCollector=result.chosenCollector;
        job.ocrTextBottom = result.ocrTextBottom;
 
        await job.save();
 
        // B8: Push new review item to all SSE clients
        notifyReviewClients();
 
      } catch (e) {
        job.lastError = e?.message || String(e);
        if (job.attempts >= SCAN_MAX_ATTEMPTS) {
          job.status     = "failed";
          job.finishedAt = new Date();
        } else {
          job.status = "queued";
        }
        await job.save();
      } finally {
        try {
          const terminal = job.status === "done" || job.status === "failed";
          if (terminal && job.filePath && fs.existsSync(job.filePath)) {
            fs.unlinkSync(job.filePath);
          }
        } catch {}
        scanInFlight--;
        // Re-drain: if more jobs arrived while this one ran, pick them up now.
        scanWorkerTick().catch(() => {});
      }
    })();
  }
}
 
// B5: Catch-all poll timer — handles edge cases where the push trigger was missed.
setInterval(() => {
  scanWorkerTick().catch(err => console.error("❌ scanWorkerTick:", err));
}, WORKER_POLL_MS);

// -------------------- Inventory Review API --------------------

// Get all review items
app.get("/api/review/inventory", (req, res) => {
  try {
    const items = readReviewQueue();
    res.json({ items });
  } catch (err) {
    console.error("❌ review queue fetch failed:", err);
    res.status(500).json({ error: "Failed to read review queue" });
  }
});

// Remove a review item
app.delete("/api/review/inventory/:id", (req, res) => {
  try {
    const removed = removeReviewItemById(req.params.id);

    if (!removed) {
      return res.status(404).json({ error: "Item not found" });
    }

    res.json({ success: true });
  } catch (err) {
    console.error("❌ review delete failed:", err);
    res.status(500).json({ error: "Failed to delete review item" });
  }
});

// Approve a review item (adds to inventory)
app.post("/api/review/inventory/:id/approve", async (req, res) => {
  try {
    const item = findReviewItemById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: "Review item not found" });
    }

    const chosen = item.chosen;

    if (!chosen) {
      return res.status(400).json({ error: "No chosen card to approve" });
    }

    const price = parseFloat(req.body.price || 0);

    const inventoryItem = {
      cardName: chosen.name,
      set: chosen.set_name,
      condition: item.condition || "NM",
      foil: !!item.foil,
      priceUsd: price,
      imageUrl: chosen.imageUrl || ""
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

    removeReviewItemById(req.params.id);

    res.json({ success: true });

  } catch (err) {
    console.error("❌ review approve failed:", err);
    res.status(500).json({ error: "Approval failed" });
  }
});

// -------------------- INVENTORY REVIEW API --------------------

// Get review queue
app.get("/api/inventory-review", (req, res) => {
  try {
    const items = readReviewQueue();
    res.json(items);
  } catch (err) {
    console.error("❌ Failed loading review queue:", err);
    res.status(500).json({ message: "Failed to load review queue." });
  }
});


// Approve review item and add to inventory
app.post("/api/inventory-review/:id/approve", async (req, res) => {
  try {
    const id = req.params.id;
    const item = findReviewItemById(id);

    if (!item) {
      return res.status(404).json({ message: "Review item not found." });
    }

    const {
      cardName,
      setName,
      collectorNumber,
      condition
    } = req.body;

    const finalName = cardName || item?.chosen?.name;
    const finalSet = setName || item?.chosen?.set_name;
    const finalCondition = condition || item.condition;

    const imageUrl =
      item?.chosen?.imageUrl ||
      item?.chosen?.image_uris?.normal ||
      "";

    await CardInventory.findOneAndUpdate(
      {
        cardName: finalName,
        set: finalSet,
        foil: item.foil,
        condition: finalCondition
      },
      {
        $inc: { quantity: 1 },
        $setOnInsert: {
          cardName: finalName,
          set: finalSet,
          foil: item.foil,
          condition: finalCondition,
          imageUrl,
          priceUsd: 0
        }
      },
      { upsert: true }
    );

    removeReviewItemById(id);

    res.json({ success: true });

  } catch (err) {
    console.error("❌ Approve review item error:", err);
    res.status(500).json({ message: "Failed to approve item." });
  }
});


// Reject / delete review item
app.delete("/api/inventory-review/:id", (req, res) => {
  try {
    const id = req.params.id;

    const removed = removeReviewItemById(id);

    if (!removed) {
      return res.status(404).json({ message: "Item not found." });
    }

    res.json({ success: true });

  } catch (err) {
    console.error("❌ Failed deleting review item:", err);
    res.status(500).json({ message: "Failed deleting review item." });
  }
});

app.get("/api/watch-folder-debug", (req, res) => {
  try {
    const WATCH_DIR = path.join(__dirname, "watch_folder");
    const files = fs.existsSync(WATCH_DIR) ? fs.readdirSync(WATCH_DIR) : [];
    res.json({ watchDir: WATCH_DIR, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

registerCropDebugRoutes(app);

// Start Server
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
