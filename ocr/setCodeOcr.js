// ocr/setCodeOcr.js
// Crops and OCRs the set code that appears directly below the collector number
// on a standard MTG card (e.g. "SLD", "M21", "2XM", "DMR").
//
// Region layout (bottom-left of card, 300 DPI + 1mm border):
//   Collector number: H * 0.920 → H * 0.940  (already handled by collectorOcr.js)
//   Set code:         H * 0.940 → H * 0.960  (this file)
//
// The set code is a short uppercase alphanumeric string, 2–6 chars.
// We share the Tesseract worker pool from nameOcr.js (C10 pattern).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");
const { acquireWorker, releaseWorker, recognizeWithTimeout } = require("./nameOcr");
const { OCR_THRESHOLDS } = require("./constants");

// ─── Region builder ───────────────────────────────────────────────────────────

/**
 * Returns the crop region(s) to try for the set code.
 * Mirrors the structure of buildCollectorRegions() in imageUtils.js.
 *
 * The set code sits just below the collector number, left-side of the bottom
 * info line. We keep the x-bounds identical to the collector region so the
 * two crops are spatially consistent and easy to calibrate together.
 *
 * @param {number} W - Image width in pixels
 * @param {number} H - Image height in pixels
 * @returns {Array<{left, top, width, height}>}
 */
function buildSetCodeRegions(W, H) {
  return [
    // Primary: directly below collector number, same horizontal band
    {
      left:   Math.floor(W * 0.06),
      top:    Math.floor(H * 0.940),
      width:  Math.floor(W * 0.20),   // wider than collector — set codes vary in length
      height: Math.floor(H * 0.022),
    },
    // Fallback: slightly taller crop in case of vertical registration shift
    {
      left:   Math.floor(W * 0.06),
      top:    Math.floor(H * 0.936),
      width:  Math.floor(W * 0.22),
      height: Math.floor(H * 0.030),
    },
  ];
}

// ─── Image prep ───────────────────────────────────────────────────────────────

/**
 * Crop + preprocess a set-code region to a temp PNG ready for Tesseract.
 * Identical pipeline to cropAndPrepCollectorRegion() in imageUtils.js.
 */
async function cropAndPrepSetCodeRegion(
  originalPath,
  outPath,
  region,
  useThreshold = false,
  dx = 0,
  dy = 0,
  thresholdValue = 180
) {
  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const left   = Math.max(0, Math.min(W - 2, region.left + dx));
  const top    = Math.max(0, Math.min(H - 2, region.top  + dy));
  const width  = Math.max(1, Math.min(region.width,  W - left));
  const height = Math.max(1, Math.min(region.height, H - top));

  const dir = path.dirname(outPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}

  let pipeline = sharp(originalPath)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 1800, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(thresholdValue);

  await pipeline.toFile(outPath);
}

// ─── Text cleaning ────────────────────────────────────────────────────────────

/**
 * Keep only uppercase letters and digits; collapse whitespace.
 * Set codes are 2–6 chars, all caps, no punctuation.
 */
function cleanSetCode(raw) {
  return (raw || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^A-Z0-9 ]/gi, "")
    .trim()
    .toUpperCase();
}

/**
 * Extract the first plausible set code token from cleaned OCR text.
 * Returns null if nothing looks like a set code.
 */
function parseSetCode(text) {
  const s = cleanSetCode(text);

  // Try each whitespace-separated token, pick the first that's 2–6 alpha-num chars.
  const tokens = s.split(/\s+/);
  for (const tok of tokens) {
    if (/^[A-Z0-9]{2,6}$/.test(tok)) {
      return tok;
    }
  }
  return null;
}

// ─── Tesseract config ─────────────────────────────────────────────────────────

// Whitelist: uppercase letters + digits only. No slash, no space needed.
const SET_CODE_OPTS = {
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ",
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * OCR the set code from a scanned card image.
 *
 * Fast path: region[0] × [null, 180] thresholds (2 passes).
 * Full sweep: both regions × all OCR_THRESHOLDS (fallback, ~8 passes).
 *
 * Returns: { text, confidence, setCode }
 *   setCode — 2–6 char uppercase string, or null if not found.
 */
async function ocrSetCodeHighAccuracy(originalPath, tmpDir) {
  const ts = Date.now();

  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  if (!fs.existsSync(originalPath)) {
    return { text: "", confidence: 0, setCode: null, error: "input_missing" };
  }

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const regions = buildSetCodeRegions(W, H);

  // Share the nameOcr worker pool (C10 pattern)
  const slot = await acquireWorker();

  try {
    // ── Fast path: region 0 × [null, 180] ────────────────────────────────────
    const fastPasses = [
      { regionIndex: 0, thr: null },
      { regionIndex: 0, thr: 180 },
    ];

    for (const { regionIndex, thr } of fastPasses) {
      const region = regions[regionIndex];
      const useThreshold = thr !== null && thr !== undefined;
      const tag = `setcode_${ts}_fast_r${regionIndex}_t${thr ?? "raw"}`;
      const out = path.join(tmpDir, `${tag}.png`);

      try {
        await cropAndPrepSetCodeRegion(originalPath, out, region, useThreshold, 0, 0, thr ?? 180);
        const ocr = await recognizeWithTimeout(out, 20000, slot);
        const text = cleanSetCode(ocr?.data?.text);
        const conf = ocr?.data?.confidence ?? 0;
        const setCode = parseSetCode(text);

        if (setCode && conf >= 60) {
          console.log(`✅ [setCodeOcr] Fast-path hit: "${setCode}" (conf=${conf})`);
          return { text, confidence: conf, setCode };
        }
      } catch {
        // fall through
      } finally {
        try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
      }
    }

    // ── Full sweep ────────────────────────────────────────────────────────────
    console.log(`⚠️ [setCodeOcr] Fast path miss, running full sweep for: ${path.basename(originalPath)}`);

    const candidates = [];

    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];

      for (let t = 0; t < OCR_THRESHOLDS.length; t++) {
        const thr = OCR_THRESHOLDS[t];
        const useThreshold = thr !== null && thr !== undefined;
        const out = path.join(tmpDir, `setcode_${ts}_r${i}_t${t}.png`);

        try {
          await cropAndPrepSetCodeRegion(originalPath, out, region, useThreshold, 0, 0, thr ?? 180);
          const ocr = await recognizeWithTimeout(out, 20000, slot);
          const text = cleanSetCode(ocr?.data?.text);
          const conf = ocr?.data?.confidence ?? 0;
          const setCode = parseSetCode(text);

          candidates.push({ regionIndex: i, thrIndex: t, text, conf, setCode });

          if (setCode && conf >= 60) {
            return { text, confidence: conf, setCode };
          }
        } catch {
          candidates.push({ regionIndex: i, thrIndex: t, text: "", conf: 0, setCode: null });
        } finally {
          try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
        }
      }
    }

    // Pick best candidate: prefer non-null setCode, then highest confidence
    candidates.sort(
      (a, b) =>
        (b.setCode ? 1 : 0) - (a.setCode ? 1 : 0) ||
        b.conf - a.conf
    );

    const best = candidates[0] || { text: "", conf: 0, setCode: null };

    if (!best.setCode) {
      console.log("⚠️ [setCodeOcr] No valid set code found:", originalPath);
    }

    return {
      text: best.text || "",
      confidence: best.conf || 0,
      setCode: best.setCode || null,
    };
  } finally {
    releaseWorker(slot);
  }
}

module.exports = {
  ocrSetCodeHighAccuracy,
  buildSetCodeRegions,
  cropAndPrepSetCodeRegion,
  parseSetCode,
};
