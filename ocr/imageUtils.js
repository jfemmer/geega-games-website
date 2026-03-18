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


async function cropAndPrepCollectorRegion(originalPath, outPath, region, useThreshold = false, dx = 0, dy = 0, thresholdValue = 180) {
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
    .resize({ width: 1800, withoutEnlargement: false })

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
    // 🔴 LEFT (set code / rarity area)
    {
      left: Math.floor(W * 0.04),
      top: Math.floor(H * 0.915),
      width: Math.floor(W * 0.18),
      height: Math.floor(H * 0.035),
    },

    // 🔴 MIDDLE (collector number sometimes appears here)
    {
      left: Math.floor(W * 0.40),
      top: Math.floor(H * 0.92),
      width: Math.floor(W * 0.20),
      height: Math.floor(H * 0.04),
    },

    // 🔴 RIGHT (most common collector number position)
    {
      left: Math.floor(W * 0.60),
      top: Math.floor(H * 0.92),
      width: Math.floor(W * 0.22),
      height: Math.floor(H * 0.04),
    },
  ];
}

module.exports = {
  cropAndPrepNameBar,
  buildCollectorRegions,
  detectWhiteBorder,
};
