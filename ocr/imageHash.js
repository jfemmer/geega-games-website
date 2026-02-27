// ocr/imageHash.js
const sharp = require("sharp");
const axios = require("axios");

// --------- Artwork crop (percent-based, works across resolutions) ----------
async function cropArtworkBuffer(imagePathOrBuffer) {
  const img = sharp(imagePathOrBuffer);
  const meta = await img.metadata();
  const W = meta.width;
  const H = meta.height;

  // MTG artwork region (typical modern-ish frames)
  // Tune later if needed; this is a strong starting point.
  const region = {
    left: Math.floor(W * 0.11),
    top: Math.floor(H * 0.17),
    width: Math.floor(W * 0.78),
    height: Math.floor(H * 0.40),
  };

  // Clamp
  region.left = Math.max(0, Math.min(W - 2, region.left));
  region.top = Math.max(0, Math.min(H - 2, region.top));
  region.width = Math.max(1, Math.min(region.width, W - region.left));
  region.height = Math.max(1, Math.min(region.height, H - region.top));

  return await img
    .extract(region)
    .grayscale()
    .normalize()
    .toBuffer();
}

// --------- dHash (64-bit, returned as hex string) ----------
async function dhash64FromBuffer(buf) {
  // dHash: resize to 9x8, compare adjacent pixels across rows
  const { data, info } = await sharp(buf)
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // data is 9*8 grayscale bytes
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

  // 64 bits -> 16 hex chars
  return bits.toString(16).padStart(16, "0");
}

function hammingHex64(aHex, bHex) {
  if (!aHex || !bHex || aHex.length !== 16 || bHex.length !== 16) return 9999;
  const a = BigInt("0x" + aHex);
  const b = BigInt("0x" + bHex);
  let x = a ^ b;

  // popcount
  let count = 0;
  while (x) {
    x &= (x - 1n);
    count++;
  }
  return count;
}

// --------- High-level helpers ----------
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

module.exports = {
  hashScanArtwork,
  hashScryfallArtwork,
  hammingHex64,
};
