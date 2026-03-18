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
async function hashScanSetSymbol(imagePath, dx = 0, dy = 0) {
  const buf = await cropSetSymbolBuffer(imagePath, dx, dy);
  return await dhash64FromBuffer(buf);
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

module.exports = {
  hashScanArtwork,
  hashScryfallArtwork,
  hashScanSetSymbol,
  hashReferenceSymbolBuffer,
  hammingHex64,
};
