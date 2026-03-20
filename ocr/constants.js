const path = require("path");

// Scanner output varies slightly per scan (~768-771 x 1061-1062).
// FIXED_DIMS matching is disabled in imageUtils.js — we always use
// percent-based crops so dimension variance doesn't matter.
const FIXED_DIMS = { w: -1, h: -1 }; // intentionally unmatched

const BORDER_PX = 12; // 1mm at ~96 DPI (actual scanner output DPI)

const CROP = {
  // Not used directly — see imageUtils.js fallback percentages
  nameBar: {
    left:   BORDER_PX + 86,
    top:    BORDER_PX + 90,
    width:  480,
    height: 100,
  },
  setSymbol: {
    left:   BORDER_PX + 1056,
    top:    BORDER_PX + 978,
    width:  180,
    height: 157,
  },
};

const DEBUG_OCR = true;

const OCR_THRESHOLDS = [null, 180, 140, 110];

const NAME_OFFSETS = [
  { dx: 0, dy:  0 },
  { dx: 0, dy: -3 },
  { dx: 0, dy:  3 },
];

const COLLECTOR_OFFSETS = [
  { dx: 0, dy: 0 }
];

const SYMBOL_OFFSETS = [
  { dx: 0,  dy:  0 },
  { dx: 2,  dy:  0 },
  { dx: -2, dy:  0 },
  { dx: 0,  dy:  2 },
  { dx: 0,  dy: -2 },
];

const AUTO_INGEST_MIN_SCORE = 0.85;
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
