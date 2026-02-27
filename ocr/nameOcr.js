const path = require("path");
const fs = require("fs");
const Tesseract = require("tesseract.js");
const { cropAndPrepNameBar } = require("./imageUtils");
const { OCR_THRESHOLDS, NAME_OFFSETS } = require("./constants");

function cleanCardName(text) {
  let s = (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Common OCR junk at the start from borders/glare:
  // - leading punctuation
  // - repeated letters like "EEE " or "III "
  s = s.replace(/^[^A-Za-z0-9]+/g, "");              // trim non-alnum prefix
  s = s.replace(/^([A-Z])\1{2,}\s+/g, "");           // "EEE Lightning Bolt" -> "Lightning Bolt"
  s = s.replace(/^([ilI\|]){2,}\s+/g, "");           // "||| Counterspell" -> "Counterspell"

  // Keep split cards like "Fire // Ice"
  s = s.replace(/[^A-Za-z0-9 ',-/]/g, "").trim();

  // If there’s still a tiny junk prefix like "E Lightning Bolt", strip it
  if (s.length > 4) {
    s = s.replace(/^[A-Z]\s+(?=[A-Za-z]{3,})/, "");
  }

  return s;
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

  // ✅ Ensure tmpDir exists (refactors often break this)
  try {
    if (!tmpDir) throw new Error("tmpDir is missing");
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    console.log("🔴 [nameOcr] tmpDir mkdir failed:", tmpDir, e.message);
    // If we can't write crops, OCR will be unreliable; fail fast.
    return { name: "", confidence: 0, error: "tmpDir_not_writable" };
  }

  // ✅ Sanity: input exists
  try {
    if (!fs.existsSync(originalPath)) {
      console.log("🔴 [nameOcr] originalPath missing:", originalPath);
      return { name: "", confidence: 0, error: "input_missing" };
    }
  } catch {}

  const tesseractOptions = {
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-/",
    // extra stability knobs:
    tessedit_ocr_engine_mode: 1, // LSTM only
    load_system_dawg: 0,
    load_freq_dawg: 0,
    preserve_interword_spaces: 1,
  };

  const offsets = NAME_OFFSETS;

  const candidates = [];

  for (let i = 0; i < offsets.length; i++) {
    const { dx, dy } = offsets[i];

    for (let t = 0; t < OCR_THRESHOLDS.length; t++) {
      const thr = OCR_THRESHOLDS[t]; // null => no threshold
      const useThreshold = thr !== null && thr !== undefined;

      const out = path.join(tmpDir, `name_${ts}_o${i}_t${t}.png`);

      // crop
      try {
        console.log("🟣 [nameOcr] cropping name bar ->", { out, dx, dy, thr });
        await cropAndPrepNameBar(originalPath, out, useThreshold, dx, dy, thr ?? 180);
        if (!fs.existsSync(out)) continue;
      } catch (e) {
        console.log("🔴 [nameOcr] cropAndPrepNameBar failed:", e.message);
        continue;
      }

      // OCR
      try {
        const o = await recognizeWithTimeout(out, 90000, tesseractOptions);
        const name = cleanCardName(o?.data?.text);
        const conf = o?.data?.confidence ?? 0;
        if (name) candidates.push({ name, confidence: conf });
        // early win
        if (name && conf >= 85) break;
      } catch (e) {
        console.log("🔴 [nameOcr] Tesseract failed:", e.message);
      }
    }
  }

  // Pick best candidate (confidence first, then longer name)
  candidates.sort(
    (a, b) => (b.confidence - a.confidence) || (b.name.length - a.name.length)
  );

  const best = candidates[0] || { name: "", confidence: 0 };

  // Helpful debug when everything fails
  if (!best.name) {
    console.log("⚠️ [nameOcr] No candidates produced", {
      originalPath,
      tmpDir,
      candidatesCount: candidates.length
    });
  }

  return best;
}

module.exports = {
  ocrCardNameHighAccuracy,
  recognizeWithTimeout,
};
