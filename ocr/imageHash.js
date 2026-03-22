// ocr/imageHash.js
const sharp = require("sharp");
const axios = require("axios");
const { CROP } = require("./constants");

function clampRegion(region, W, H) {
  const out = { ...region };
  out.left = Math.max(0, Math.min(W - 2, out.left));
  out.top = Math.max(0, Math.min(H - 2, out.top));
  out.width = Math.max(1, Math.min(out.width, W - out.left));
  out.height = Math.max(1, Math.min(out.height, H - out.top));
  return out;
}

// --------- Artwork crop (percent-based, works across resolutions) ----------
async function cropArtworkBuffer(imagePathOrBuffer) {
  const img = sharp(imagePathOrBuffer);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const region = clampRegion({
    left: Math.floor(W * 0.11),
    top: Math.floor(H * 0.17),
    width: Math.floor(W * 0.78),
    height: Math.floor(H * 0.40),
  }, W, H);

  return await img
    .extract(region)
    .grayscale()
    .normalize()
    .toBuffer();
}

// --------- Set symbol crop ----------
async function cropSetSymbolBuffer(imagePathOrBuffer, dx = 0, dy = 0) {
  const img = sharp(imagePathOrBuffer);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const base = CROP.setSymbol;
  if (!base) throw new Error("CROP.setSymbol missing in constants.js");

  const sx = W / 771;
  const sy = H / 1061;

  const region = clampRegion({
    left: Math.round(base.left * sx + dx),
    top: Math.round(base.top * sy + dy),
    width: Math.round(base.width * sx),
    height: Math.round(base.height * sy),
  }, W, H);

  return await img
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    .resize(96, 96, { fit: "fill" })
    .threshold(160)
    .toBuffer();
}

// --------- dHash (64-bit, returned as hex string) ----------
async function dhash64FromBuffer(buf) {
  const { data } = await sharp(buf)
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bits = 0n;
  let bitIndex = 0n;

  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const left = data[y * 9 + x];
      const right = data[y * 9 + (x + 1)];
      const bit = left < right ? 1n : 0n;
      bits |= (bit << bitIndex);
      bitIndex++;
    }
  }

  return bits.toString(16).padStart(16, "0");
}

function hammingHex64(aHex, bHex) {
  if (!aHex || !bHex || aHex.length !== 16 || bHex.length !== 16) return 9999;
  const a = BigInt("0x" + aHex);
  const b = BigInt("0x" + bHex);
  let x = a ^ b;

  let count = 0;
  while (x) {
    x &= (x - 1n);
    count++;
  }
  return count;
}

// --------- Existing artwork helpers ----------
async function hashScanArtwork(imagePath) {
  const artBuf = await cropArtworkBuffer(imagePath);
  return await dhash64FromBuffer(artBuf);
}

async function fetchScryfallImageBuffer(card) {
  const url =
    card?.image_uris?.small ||
    card?.image_uris?.normal ||
    card?.card_faces?.[0]?.image_uris?.small ||
    card?.card_faces?.[0]?.image_uris?.normal;

  if (!url) throw new Error("No Scryfall image URL");

  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function hashScryfallArtwork(card) {
  const buf = await fetchScryfallImageBuffer(card);
  const artBuf = await cropArtworkBuffer(buf);
  return await dhash64FromBuffer(artBuf);
}

// --------- Symbol helpers ----------
async function hashScanSetSymbol(imagePath, dx = 0, dy = 0, returnBuffer = false) {
  const img = sharp(imagePath);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const { left, top, width, height } = CROP.setSymbol;

  const region = clampRegion({ left: left + dx, top: top + dy, width, height }, W, H);

  // Hash input: matches hashReferenceSymbolBuffer pipeline exactly
  const hashBuf = await sharp(imagePath)
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    .resize(96, 96, { fit: "fill" })
    .threshold(160)
    .toBuffer();

  const hash = await dhash64FromBuffer(hashBuf);

  if (returnBuffer) {
    // Debug view: thresholded so the symbol shape is visible, not raw card texture
    const debugBuf = await sharp(imagePath)
      .extract(region)
      .grayscale()
      .normalize()
      .sharpen()
      .resize(256, 256, { fit: "fill" })
      .threshold(160)
      .png()
      .toBuffer();
    return { hash, buffer: debugBuf };
  }

  return hash;
}

async function hashReferenceSymbolBuffer(imagePathOrBuffer) {
  const buf = await sharp(imagePathOrBuffer)
    .grayscale()
    .normalize()
    .resize(96, 96, { fit: "fill" })
    .sharpen()
    .threshold(160)
    .png()
    .toBuffer();

  return await dhash64FromBuffer(buf);
}

async function cropTitleBarBuffer(imagePathOrBuffer) {
  const img = sharp(imagePathOrBuffer);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const region = clampRegion({
    left: Math.floor(W * 0.07),
    top: Math.floor(H * 0.03),
    width: Math.floor(W * 0.74),
    height: Math.floor(H * 0.07),
  }, W, H);

  return await img
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    .resize(192, 48, { fit: "fill" })
    .toBuffer();
}

async function cropFrameBuffer(imagePathOrBuffer) {
  const img = sharp(imagePathOrBuffer);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const region = clampRegion({
    left: Math.floor(W * 0.04),
    top: Math.floor(H * 0.03),
    width: Math.floor(W * 0.92),
    height: Math.floor(H * 0.94),
  }, W, H);

  return await img
    .extract(region)
    .grayscale()
    .normalize()
    .sharpen()
    .resize(128, 128, { fit: "fill" })
    .toBuffer();
}

async function cropFullCardBuffer(imagePathOrBuffer) {
  const img = sharp(imagePathOrBuffer);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  const region = clampRegion({
    left: 0,
    top: 0,
    width: W,
    height: H,
  }, W, H);

  return await img
    .extract(region)
    .grayscale()
    .normalize()
    .resize(128, 128, { fit: "fill" })
    .toBuffer();
}

async function hashScanFrame(imagePath) {
  const buf = await cropFrameBuffer(imagePath);
  return await dhash64FromBuffer(buf);
}

async function hashScanTitle(imagePath) {
  const buf = await cropTitleBarBuffer(imagePath);
  return await dhash64FromBuffer(buf);
}

async function hashScanFull(imagePath) {
  const buf = await cropFullCardBuffer(imagePath);
  return await dhash64FromBuffer(buf);
}

async function hashLocalImageFingerprints(imagePath) {
  const [art_hash, frame_hash, title_hash, full_hash, symbol_hash] = await Promise.all([
    hashScanArtwork(imagePath),
    hashScanFrame(imagePath),
    hashScanTitle(imagePath),
    hashScanFull(imagePath),
    hashScanSetSymbol(imagePath).catch(() => null),
  ]);

  return {
    art_hash,
    frame_hash,
    title_hash,
    full_hash,
    symbol_hash
  };
}

module.exports = {
  hashScanArtwork,
  hashScryfallArtwork,
  hashScanSetSymbol,
  hashReferenceSymbolBuffer,
  hashScanFrame,
  hashScanTitle,
  hashScanFull,
  hashLocalImageFingerprints,
  hammingHex64,
};
