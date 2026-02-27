const path = require("path");
const fs = require("fs");
const FIXED_DIMS = { w: 771, h: 1061 };


// Tuned crop boxes for the FI-8170 format
const CROP = {
  // Top name bar strip
  nameBar: { left: 80, top: 32, width: 520, height: 85},

  // Optional later if you want collector # matching:
  bottomLine: { left: 154, top: 923, width: 462, height: 127 },
};

const DEBUG_OCR = true;

const DEBUG_DIR = path.join(__dirname, "..", "ocr_debug");

module.exports = {
  FIXED_DIMS,
  CROP,
};
