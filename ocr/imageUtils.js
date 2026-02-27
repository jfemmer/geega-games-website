async function cropAndPrepNameBar(originalPath, outPath, useThreshold = false, dx = 0, dy = 0) {
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
  const region = {
    left: Math.max(0, Math.min(W - 1, base.left + dx)),
    top: Math.max(0, Math.min(H - 1, base.top + dy)),
    width: Math.min(base.width, W - Math.max(0, base.left + dx)),
    height: Math.min(base.height, H - Math.max(0, base.top + dy)),
  };

  let pipeline = sharp(originalPath)
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 1400, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(180);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    await sharp(outPath).toFile(debugCopy);
    console.log("🟣 Saved NAME crop to:", debugCopy);
  }
}

async function cropAndPrepBottomLine(originalPath, outPath, region, useThreshold = false) {
  let pipeline = sharp(originalPath)
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    .resize({ width: 1600, withoutEnlargement: false });

  if (useThreshold) pipeline = pipeline.threshold(180);

  await pipeline.toFile(outPath);

  if (DEBUG_OCR) {
    const debugCopy = path.join(DEBUG_DIR, path.basename(outPath));
    await sharp(outPath).toFile(debugCopy);
    console.log("🔵 Saved BOTTOM crop to:", debugCopy);
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
  // If your FI-8170 scans are consistently 771x1061, you can tune these.
  // These are *percentage-based* so they still work if resolution changes.
  // The idea: try bottom-left in a few slightly different spots/heights.
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
