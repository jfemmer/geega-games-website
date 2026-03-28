const sharp = require("sharp");
const path = require("path");
const fs = require("fs");
const { FIXED_DIMS, CROP, DEBUG_OCR, DEBUG_DIR } = require("./constants");

// FIX 1: imageUtils.js now uses CROP.nameBar from constants.js as the single
// source of truth for name bar crop coordinates. Previously there were two
// conflicting definitions — a hardcoded percent-based crop here that differed
// from CROP.nameBar. The percent-based math is kept but now derived from
// CROP.nameBar values at FIXED_DIMS, so both systems agree.
//
// Scale factors allow the crop to work at any scanner resolution, not just
// FIXED_DIMS. At exactly FIXED_DIMS the sx/sy factors are 1.0.

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

  // FIX 1: Scale CROP.nameBar pixel coords to this scan's actual dimensions.
  // CROP.nameBar is calibrated for FIXED_DIMS ({w:1299, h:1777}).
  // sx/sy are 1.0 when the scan is exactly that size, and scale gracefully
  // if the scanner produces slightly different output dimensions.
  const sx = W / FIXED_DIMS.w;
  const sy = H / FIXED_DIMS.h;

  const base = {
    left:   Math.round(CROP.nameBar.left   * sx),
    top:    Math.round(CROP.nameBar.top    * sy),
    width:  Math.round(CROP.nameBar.width  * sx),
    height: Math.round(CROP.nameBar.height * sy),
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
      console.log(`🟣 Saved NAME crop to (no-copy): ${outPath}`);
    }
  }
}

// Old-frame name bar crop (pre-8th Edition, ~1993–2003).
// These cards have a taller name bar positioned slightly higher on the card.
// The old-frame crop does NOT use CROP.nameBar because that is calibrated for
// modern-frame positioning. Instead it uses its own offset, also scaled.
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

  const sx = W / FIXED_DIMS.w;
  const sy = H / FIXED_DIMS.h;

  // Old-frame name bar sits ~10px higher than CROP.nameBar.top and is ~15%
  // taller. Derive from CROP.nameBar so there is still one source of truth;
  // the old-frame adjustments are expressed as deltas.
  const base = {
    left:   Math.round(CROP.nameBar.left   * sx),
    top:    Math.round((CROP.nameBar.top - 10) * sy),   // slightly higher
    width:  Math.round(CROP.nameBar.width  * sx),
    height: Math.round(CROP.nameBar.height * 1.15 * sy), // ~15% taller
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
      top:    Math.floor(H * 0.920),
      width:  Math.floor(W * 0.13),
      height: Math.floor(H * 0.020),
    },
  ];
}

module.exports = {
  cropAndPrepNameBar,
  cropAndPrepNameBarOldFrame,
  cropAndPrepCollectorRegion,
  buildCollectorRegions,
  detectWhiteBorder,
};
