// ocr/collectorOcr.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");

const { recognizeWithTimeout } = require("./nameOcr");
const { cropAndPrepBottomLine, buildCollectorRegions } = require("./imageUtils");
const { OCR_THRESHOLDS, COLLECTOR_OFFSETS } = require("./constants");

function cleanBottomText(text) {
  return (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCollectorNumberStrict(bottomText) {
  const s = (bottomText || "")
    .replace(/\s+/g, " ")
    .replace(/[|]/g, "/")         // common OCR swap
    .replace(/[^0-9/ ]/g, "")     // keep only digits + slash + spaces
    .trim();

  // Prefer formats like "123/350"
  const m1 = s.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
  if (m1) {
    const n = parseInt(m1[1], 10);
    return Number.isFinite(n) ? { value: String(n), mode: "slash" } : null;
  }

  // Fallback: standalone number (less safe)
  const m2 = s.match(/\b(\d{1,4})\b/);
  if (m2) {
    const n = parseInt(m2[1], 10);
    return Number.isFinite(n) ? { value: String(n), mode: "standalone" } : null;
  }

  return null;
}

async function ocrCollectorNumberHighAccuracy(originalPath, tmpDir) {
  const ts = Date.now();

  // Ensure tmpDir exists (refactors often break this)
  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  // Input sanity
  if (!fs.existsSync(originalPath)) {
    return { text: "", confidence: 0, collectorNumber: null, error: "input_missing" };
  }

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const regions = buildCollectorRegions(W, H);

  // Collector number works best as SINGLE_LINE with numeric whitelist
  const optsStrict = {
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: "0123456789/ ",
  };

  const candidates = [];

  // Try multiple region templates + small jitter offsets + multiple thresholds
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];

    for (let o = 0; o < COLLECTOR_OFFSETS.length; o++) {
      const { dx, dy } = COLLECTOR_OFFSETS[o];

      for (let t = 0; t < OCR_THRESHOLDS.length; t++) {
        const thr = OCR_THRESHOLDS[t];
        const useThreshold = thr !== null && thr !== undefined;

        const out = path.join(tmpDir, `bottom_${ts}_r${i}_o${o}_t${t}.png`);

        try {
          await cropAndPrepBottomLine(originalPath, out, region, useThreshold, dx, dy, thr ?? 180);
          const ocr = await recognizeWithTimeout(out, 90000, optsStrict);
          const text = cleanBottomText(ocr?.data?.text);
          const conf = ocr?.data?.confidence ?? 0;
          const parsed = parseCollectorNumberStrict(text);

          const collectorNumber = parsed?.value ?? null;
          const parseMode = parsed?.mode ?? null;

          candidates.push({
            regionIndex: i,
            offsetIndex: o,
            thrIndex: t,
            text,
            conf,
            collectorNumber,
            parseMode,
          });

          // ✅ Confidence gating:
          // - slash parses are reliable at lower conf
          // - standalone parses must be much higher confidence to avoid poisoning
          const minConf = parseMode === "standalone" ? 75 : 55;

          if (collectorNumber && conf >= minConf) {
            return { text, confidence: conf, collectorNumber };
          }
        } catch (e) {
          candidates.push({
            regionIndex: i,
            offsetIndex: o,
            thrIndex: t,
            text: "",
            conf: 0,
            collectorNumber: null,
            parseMode: null,
            err: e?.message || String(e),
          });
        } finally {
          // cleanup temp crops (optional; comment out if you want to inspect)
          try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
        }
      }
    }
  }

  // Pick best candidate:
  // 1) prefer those that parsed a collector number
  // 2) prefer slash parses over standalone
  // 3) higher confidence
  candidates.sort(
    (a, b) =>
      (b.collectorNumber ? 1 : 0) - (a.collectorNumber ? 1 : 0) ||
      ((b.parseMode === 'slash') ? 1 : 0) - ((a.parseMode === 'slash') ? 1 : 0) ||
      (b.conf - a.conf)
  );

  const best = candidates[0] || { text: "", conf: 0, collectorNumber: null };

  return {
    text: best.text || "",
    confidence: best.conf || 0,
    collectorNumber: best.collectorNumber || null,
  };
}

module.exports = {
  ocrCollectorNumberHighAccuracy,
};
