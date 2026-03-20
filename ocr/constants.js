const path = require("path");
const FIXED_DIMS = { w: 771, h: 1061 };

// Tuned crop boxes for the FI-8170 format
const CROP = {
  // Top name bar strip
  nameBar: {
    left: 58,
    top: 34,
    width: 565,
    height: 62,
  },


  // Upper-right set symbol crop (starting point; tune with debug logs if needed)
   setSymbol: {
      left: 632,
      top: 587,
      width: 108,
      height: 94,
    },
};

const DEBUG_OCR = false;

// Try multiple thresholds for robustness (glare/contrast variance)
const OCR_THRESHOLDS = [null, 160];

const NAME_OFFSETS = [
  { dx: 0, dy: 0 }
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
