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

  // Percent-based crop — calibrated from debug crops at ~770x1062 (Counterspell).
  // Scales correctly to any scanner resolution including fi-8170 at 1299x1777.
  //   top:    5.5% — skips outer border + hatched frame region
  //   height: 7%   — captures full name text including descenders
  //   left:   7.5% — skips left card border
  //   width:  60%  — stops before mana cost symbols
  // NOTE: CROP.nameBar in constants.js is NOT used here — it was calibrated
  // for a different resolution and places the crop too high on fi-8170 scans.
  const base = {
    left:   Math.floor(W * 0.075),
    top:    Math.floor(H * 0.055),
    width:  Math.floor(W * 0.60),
    height: Math.floor(H * 0.07),
  };

  const left   = Math.max(0, Math.min(W - 2, base.left + dx));
  const top    = Math.max(0, Math.min(H - 2, base.top  + dy));
  const width  = Math.max(1, Math.min(base.width,  W - left));
  const height = Math.max(1, Math.min(base.height, H - top));

  let pipeline = sharp(originalPath)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.2, m1: 0.5, m2: 0.3 })
    .resize({ width: 1600, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(thresholdValue);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    if (!samePath(debugCopy, outPath)) {
      await sharp(outPath).toFile(debugCopy);
      console.log(`🟣 Saved NAME crop to: ${debugCopy}  [crop: left=${left} top=${top} w=${width} h=${height}]`);
    } else {
      console.log(`🟣 Saved NAME crop to (no-copy): ${outPath}  [crop: left=${left} top=${top} w=${width} h=${height}]`);
    }
  }
}

// Old-frame name bar crop (pre-8th Edition, ~1993–2003).
// These cards have a taller name bar positioned higher on the card,
// with tan/brown background. The modern crop (top=5.5%) cuts into the border.
async function cropAndPrepNameBarOldFrame(
  originalPath,
  outPath,
  useThreshold = false,
  dx = 0,
  dy = 0,
  thresholdValue = 130
) {
  ensureDir(path.dirname(outPath));
  if (DEBUG_OCR) ensureDir(DEBUG_DIR);

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const base = {
    left:   Math.floor(W * 0.075),
    top:    Math.floor(H * 0.038),   // higher than modern (was 0.055)
    width:  Math.floor(W * 0.60),
    height: Math.floor(H * 0.090),   // taller — old frames have more name bar height
  };

  const left   = Math.max(0, Math.min(W - 2, base.left + dx));
  const top    = Math.max(0, Math.min(H - 2, base.top  + dy));
  const width  = Math.max(1, Math.min(base.width,  W - left));
  const height = Math.max(1, Math.min(base.height, H - top));

  let pipeline = sharp(originalPath)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .sharpen({ sigma: 1.2, m1: 0.5, m2: 0.3 })
    .resize({ width: 1600, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(thresholdValue);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    if (!samePath(debugCopy, outPath)) {
      await sharp(outPath).toFile(debugCopy);
      console.log(`🟤 Saved OLD-FRAME NAME crop to: ${debugCopy}  [crop: left=${left} top=${top} w=${width} h=${height}]`);
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
      left:   Math.floor(W * 0.06),
      top:    Math.floor(H * 0.920),  // was 0.915, trim top
      width:  Math.floor(W * 0.13),
      height: Math.floor(H * 0.020),  // was 0.025, reduce to keep bottom the same
    },
  ];
}

module.exports = {
  cropAndPrepNameBar,
  cropAndPrepNameBarOldFrame,   // ← add this
  cropAndPrepCollectorRegion,
  buildCollectorRegions,
  detectWhiteBorder,
};
