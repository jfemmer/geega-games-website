const path = require("path");
const FIXED_DIMS = { w: 771, h: 1061 };


// Tuned crop boxes for the FI-8170 format
const CROP = {
  // Top name bar strip
  nameBar: { left: 80, top: 32, width: 520, height: 85},

  // Optional later if you want collector # matching:
  bottomLine: { left: 154, top: 923, width: 462, height: 127 },
};

const DEBUG_OCR = true;

// Try multiple thresholds for robustness (glare/contrast variance)
const OCR_THRESHOLDS = [null, 165, 180, 195];

// Small crop jitter offsets (pixels) to tolerate scan drift
const NAME_OFFSETS = [
  { dx: 0, dy: 0 },
  { dx: 4, dy: 0 }, { dx: -4, dy: 0 },
  { dx: 0, dy: 4 }, { dx: 0, dy: -4 },
  { dx: 6, dy: 2 }, { dx: -6, dy: 2 },
  { dx: 6, dy: -2 }, { dx: -6, dy: -2 },
];

const COLLECTOR_OFFSETS = [
  { dx: 0, dy: 0 },
  { dx: 4, dy: 0 }, { dx: -4, dy: 0 },
  { dx: 8, dy: 0 }, { dx: -8, dy: 0 },
  { dx: 0, dy: 2 }, { dx: 0, dy: -2 },
  { dx: 0, dy: 4 }, { dx: 0, dy: -4 },
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
  AUTO_INGEST_MIN_SCORE,
  DEFAULT_REVIEW_QUEUE_PATH,
};
