const path = require("path");
const FIXED_DIMS = { w: 771, h: 1061 };

// Tuned crop boxes for the FI-8170 format
const CROP = {
  // ✅ FIX: Name bar — stop well before the mana cost symbols.
  // Old: width 585 (ends at px 637, overlapping the mana cost area).
  // New: width 480 (ends at px 532, safely in the clear).
  // Old: height 84 (too tall, pulling in art border or type line).
  // New: height 52 (tight around just the name text).
  // Old: top 26 (risked clipping ascenders on tall letters).
  // New: top 22 (a little more headroom).
  nameBar: {
    left: 52,
    top: 22,
    width: 480,
    height: 52,
  },

  // Upper-right set symbol crop (unchanged)
  setSymbol: {
    left: 632,
    top: 587,
    width: 108,
    height: 94,
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
