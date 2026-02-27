// /ocr/constants.js
const path = require("path");

const FIXED_DIMS = { w: 771, h: 1061 };

// Tuned crop boxes for the FI-8170 format
const CROP = {
  nameBar: { left: 80, top: 32, width: 520, height: 85 },
  bottomLine: { left: 154, top: 923, width: 462, height: 127 },
};

// control debug via env (Railway Variables): DEBUG_OCR=true/false
const DEBUG_OCR = String(process.env.DEBUG_OCR || "true") === "true";
const DEBUG_DIR = path.join(__dirname, "..", "ocr_debug");

module.exports = {
  FIXED_DIMS,
  CROP,
  DEBUG_OCR,
  DEBUG_DIR,
};
