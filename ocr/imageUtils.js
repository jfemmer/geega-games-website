const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const { FIXED_DIMS, CROP, DEBUG_OCR, DEBUG_DIR } = require("./constants");

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

function samePath(a, b) {
  try { return path.resolve(a) === path.resolve(b); } catch { return a === b; }
}

async function cropAndPrepNameBar(
  originalPath,
  outPath,
  useThreshold = false,
  dx = 0,
  dy = 0,
  thresholdValue = 180
) {
  ensureDir(path.dirname(outPath));
  if (DEBUG_OCR) ensureDir(DEBUG_DIR);

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const base =
    W === FIXED_DIMS.w && H === FIXED_DIMS.h
      ? CROP.nameBar
      : {
          // ✅ FIX: Old fallback was W*0.73 wide — pulled in mana cost symbols.
          // Name text only occupies roughly the left 60% of the name bar.
          // Right edge of mana cost area starts around 82% so stop at 60% to be safe.
          left:   Math.floor(W * 0.075),
          top:    Math.floor(H * 0.030),
          width:  Math.floor(W * 0.60),
          height: Math.floor(H * 0.052),
        };

  const left   = Math.max(0, Math.min(W - 2, base.left + dx));
  const top    = Math.max(0, Math.min(H - 2, base.top  + dy));
  const width  = Math.max(1, Math.min(base.width,  W - left));
  const height = Math.max(1, Math.min(base.height, H - top));

  let pipeline = sharp(originalPath)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    // ✅ FIX: Moderate unsharp mask instead of default sharpen.
    // Default sharpen is too aggressive on low-contrast colored name bars
    // and creates ringing artifacts that Tesseract misreads as extra letters.
    .sharpen({ sigma: 1.2, m1: 0.5, m2: 0.3 })
    // ✅ FIX: Scale to 1600px wide (was 1400). More pixels = better LSTM accuracy
    // on short strings like card names.
    .resize({ width: 1600, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(thresholdValue);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    if (!samePath(debugCopy, outPath)) {
      await sharp(outPath).toFile(debugCopy);
      console.log("🟣 Saved NAME crop to:", debugCopy);
    } else {
      console.log("🟣 Saved NAME crop to (no-copy):", outPath);
    }
  }
}

async function cropAndPrepCollectorRegion(
  originalPath,
  outPath,
  region,
  useThreshold = false,
  dx = 0,
  dy = 0,
  thresholdValue = 180
) {
  ensureDir(path.dirname(outPath));
  if (DEBUG_OCR) ensureDir(DEBUG_DIR);

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const left   = Math.max(0, Math.min(W - 2, region.left + dx));
  const top    = Math.max(0, Math.min(H - 2, region.top  + dy));
  const width  = Math.max(1, Math.min(region.width,  W - left));
  const height = Math.max(1, Math.min(region.height, H - top));

  let pipeline = sharp(originalPath)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 1800, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(thresholdValue);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    if (!samePath(debugCopy, outPath)) {
      await sharp(outPath).toFile(debugCopy);
      console.log("🔵 Saved COLLECTOR crop to:", debugCopy);
    } else {
      console.log("🔵 Saved COLLECTOR crop to (no-copy):", outPath);
    }
  }
}

async function detectWhiteBorder(filePath) {
  const { data } = await sharp(filePath)
    .extract({ left: 5, top: 5, width: 60, height: 60 })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;

  return mean > 190;
}

function buildCollectorRegions(W, H) {
  return [
    {
      left:   Math.floor(W * 0.04),
      top:    Math.floor(H * 0.915),
      width:  Math.floor(W * 0.18),
      height: Math.floor(H * 0.04),
    },
    {
      left:   Math.floor(W * 0.42),
      top:    Math.floor(H * 0.915),
      width:  Math.floor(W * 0.20),
      height: Math.floor(H * 0.04),
    },
    {
      left:   Math.floor(W * 0.62),
      top:    Math.floor(H * 0.915),
      width:  Math.floor(W * 0.22),
      height: Math.floor(H * 0.04),
    },
  ];
}

module.exports = {
  cropAndPrepNameBar,
  cropAndPrepCollectorRegion,
  buildCollectorRegions,
  detectWhiteBorder,
};
