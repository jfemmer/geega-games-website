const path = require("path");

// ✅ UPDATE: Set this to your actual 300 DPI scan dimensions once you check
// the PNG size in Windows Explorer → right-click → Properties → Details.
// At 300 DPI with a standard MTG card the fi-8170 should produce ~1275×1753
// plus the 1mm border (12px each side) = likely ~1299×1777.
// Replace these values with the exact numbers from your scanner.
const FIXED_DIMS = { w: 1299, h: 1777 };

// 1mm at 300 DPI = ~12px. Every crop value below already has this baked in
// (card content starts at pixel 12, not pixel 0).
const BORDER_PX = 12;

// Tuned crop boxes for the FI-8170 format at 300 DPI + 1mm border
const CROP = {
  // Name bar — left edge of card name text to just before mana cost symbols.
  // All values offset by BORDER_PX to account for the 1mm scanner margin.
  nameBar: {
    left:   BORDER_PX + 86,   // ~98px from image edge
    top:    BORDER_PX + 36,   // ~48px from image edge
    width:  800,              // stops well before mana cost area
    height: 86,               // tight around just the name text
  },

  // Set symbol — upper right of card
  setSymbol: {
    left:   BORDER_PX + 1056,
    top:    BORDER_PX + 978,
    width:  180,
    height: 157,
  },
};

const DEBUG_OCR = false;

// ✅ FIX: Try more thresholds. Colored/gold name bars need a lower threshold
// to keep the dark text visible. null = no binarization (use raw grayscale).
const OCR_THRESHOLDS = [null, 180, 140, 110];

const NAME_OFFSETS = [
  { dx: 0, dy: 0 },
  // ✅ FIX: Add a small vertical jitter so a slightly mis-registered scan
  // can still be caught by a second pass.
  { dx: 0, dy: -3 },
  { dx: 0, dy: 3 },
];

const COLLECTOR_OFFSETS = [
  { dx: 0, dy: 0 }
];

const SYMBOL_OFFSETS = [
  { dx: 0, dy: 0 },
  { dx: 2, dy: 0 },
  { dx: -2, dy: 0 },
  { dx: 0, dy: 2 },
  { dx: 0, dy: -2 }
];

// Confidence gating defaults (tune later with logs)
const AUTO_INGEST_MIN_SCORE = 0.85;

// Where to append JSONL review records (optional; can override)
const DEFAULT_REVIEW_QUEUE_PATH = path.join(__dirname, "..", "ocr_review_queue.jsonl");

const DEBUG_DIR = path.join(__dirname, "..", "ocr_debug");

module.exports = {
  FIXED_DIMS,
  CROP,
  DEBUG_OCR,
  DEBUG_DIR,
  OCR_THRESHOLDS,
  NAME_OFFSETS,
  COLLECTOR_OFFSETS,
  SYMBOL_OFFSETS,
  AUTO_INGEST_MIN_SCORE,
  DEFAULT_REVIEW_QUEUE_PATH,
};
