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

async function cropAndPrepNameBar(originalPath, outPath, useThreshold = false, dx = 0, dy = 0, thresholdValue = 180) {
  // Ensure parent dirs exist
  ensureDir(path.dirname(outPath));
  if (DEBUG_OCR) ensureDir(DEBUG_DIR);

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const base =
    W === FIXED_DIMS.w && H === FIXED_DIMS.h
      ? CROP.nameBar
      : {
          left: Math.floor(W * 0.08),
          top: Math.floor(H * 0.055),
          width: Math.floor(W * 0.78),
          height: Math.floor(H * 0.055),
        };

  // apply offset + clamp inside image
  const left = Math.max(0, Math.min(W - 2, base.left + dx));
  const top = Math.max(0, Math.min(H - 2, base.top + dy));
  const width = Math.max(1, Math.min(base.width, W - left));
  const height = Math.max(1, Math.min(base.height, H - top));

  const region = { left, top, width, height };

  let pipeline = sharp(originalPath)
    .extract(region)
    .grayscale()
    .normalize()
    .blur(0.3) 
    .sharpen()
    .resize({ width: 1400, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(thresholdValue);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));

    // ✅ avoid "Cannot use same file for input and output"
    if (!samePath(debugCopy, outPath)) {
      await sharp(outPath).toFile(debugCopy);
      console.log("🟣 Saved NAME crop to:", debugCopy);
    } else {
      console.log("🟣 Saved NAME crop to (no-copy):", outPath);
    }
  }
}

async function cropAndPrepBottomLine(originalPath, outPath, region, useThreshold = false, dx = 0, dy = 0, thresholdValue = 180) {
  // Ensure parent dirs exist
  ensureDir(path.dirname(outPath));
  if (DEBUG_OCR) ensureDir(DEBUG_DIR);

  // Clamp region safely (avoid sharp extract errors if region goes out of bounds)
  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const left = Math.max(0, Math.min(W - 2, (region.left + dx)));
  const top = Math.max(0, Math.min(H - 2, (region.top + dy)));
  const width = Math.max(1, Math.min(region.width, W - left));
  const height = Math.max(1, Math.min(region.height, H - top));

  let pipeline = sharp(originalPath)
    .extract({ left, top, width, height })
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 1600, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(thresholdValue);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));

    // ✅ avoid "Cannot use same file for input and output"
    if (!samePath(debugCopy, outPath)) {
      await sharp(outPath).toFile(debugCopy);
      console.log("🔵 Saved BOTTOM crop to:", debugCopy);
    } else {
      console.log("🔵 Saved BOTTOM crop to (no-copy):", outPath);
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
    // Template E: older frame higher collector number
    {
      left: Math.floor(W * 0.05),
      top: Math.floor(H * 0.885),
      width: Math.floor(W * 0.35),
      height: Math.floor(H * 0.028),
    },
    // Template A: modern-ish bottom-left, tight
    {
      left: Math.floor(W * 0.05),
      top: Math.floor(H * 0.93),
      width: Math.floor(W * 0.28),
      height: Math.floor(H * 0.020),
    },
    // Template B: slightly higher (some layouts shift up)
    {
      left: Math.floor(W * 0.05),
      top: Math.floor(H * 0.915),
      width: Math.floor(W * 0.30),
      height: Math.floor(H * 0.024),
    },
    // Template C: a bit more to the right (different left margin)
    {
      left: Math.floor(W * 0.10),
      top: Math.floor(H * 0.93),
      width: Math.floor(W * 0.30),
      height: Math.floor(H * 0.020),
    },
    // Template D: slightly wider (if slash/denominator is being clipped)
    {
      left: Math.floor(W * 0.05),
      top: Math.floor(H * 0.93),
      width: Math.floor(W * 0.36),
      height: Math.floor(H * 0.022),
    },
    // Template F: taller height to capture clipped text
    {
      left: Math.floor(W * 0.05),
      top: Math.floor(H * 0.925),
      width: Math.floor(W * 0.36),
      height: Math.floor(H * 0.030),
    },
  ];
}

module.exports = {
  cropAndPrepNameBar,
  cropAndPrepBottomLine,
  buildCollectorRegions,
  detectWhiteBorder,
};
