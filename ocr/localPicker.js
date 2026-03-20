const path = require("path");
const fs = require("fs");
const {
  hashLocalImageFingerprints,
  hammingHex64
} = require("./imageHash");

const LOCAL_INDEX_PATH =
  process.env.LOCAL_INDEX_PATH || "D:/MTG_DATA/scryfall/local_index.json";

let LOCAL_INDEX_CACHE = null;

function loadLocalIndex() {
  if (LOCAL_INDEX_CACHE) return LOCAL_INDEX_CACHE;
  LOCAL_INDEX_CACHE = JSON.parse(fs.readFileSync(LOCAL_INDEX_PATH, "utf8"));
  return LOCAL_INDEX_CACHE;
}

function normalizeName(str = "") {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeCollector(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^0+/, "");
}

function toPublicImageUrl(localImagePath) {
  if (!localImagePath) return "";
  return `/local_card_images/${path.basename(localImagePath)}`;
}

function scoreCandidate(card, ctx) {
  let score = 0;
  const reasons = [];

  const ocrNameNorm = normalizeName(ctx.guessedName || "");
  const cardNameNorm = normalizeName(card.normalized_name || card.name || "");

  if (ocrNameNorm && ocrNameNorm === cardNameNorm) {
    score += 30;
    reasons.push("exact_name");
  }

  if (ctx.detectedSetCode && String(card.set || "").toLowerCase() === String(ctx.detectedSetCode).toLowerCase()) {
    score += 35;
    reasons.push("set_symbol_match");
  }

  const scanCollector = normalizeCollector(ctx.collectorNumber || "");
  const cardCollector = normalizeCollector(card.collector_number || "");
  if (scanCollector && scanCollector === cardCollector) {
    score += 35;
    reasons.push("exact_collector");
  } else if (
    scanCollector &&
    String(scanCollector).replace(/[^0-9]/g, "") &&
    String(scanCollector).replace(/[^0-9]/g, "") === String(card.collector_digits_only || "").replace(/^0+/, "")
  ) {
    score += 18;
    reasons.push("digits_only_collector");
  }

  if (ctx.isFoil ? !!card.foil : !!card.nonfoil) {
    score += 10;
    reasons.push("finish_match");
  }

  const artDist = hammingHex64(ctx.scan.art_hash, card.art_hash);
  const frameDist = hammingHex64(ctx.scan.frame_hash, card.frame_hash);
  const titleDist = hammingHex64(ctx.scan.title_hash, card.title_hash);
  const fullDist = hammingHex64(ctx.scan.full_hash, card.full_hash);
  const symbolDist =
    ctx.scan.symbol_hash && card.symbol_hash
      ? hammingHex64(ctx.scan.symbol_hash, card.symbol_hash)
      : 9999;

  score += Math.max(0, 30 - artDist * 2.0);
  score += Math.max(0, 24 - frameDist * 1.8);
  score += Math.max(0, 18 - titleDist * 1.5);
  score += Math.max(0, 14 - fullDist * 1.0);
  score += Math.max(0, 12 - symbolDist * 1.2);

  return {
    ...card,
    imageUrl: toPublicImageUrl(card.local_image),
    _score: score,
    _distances: {
      artDist,
      frameDist,
      titleDist,
      fullDist,
      symbolDist
    },
    _reasons: reasons
  };
}

async function findBestLocalMatches(scanImagePath, options = {}) {
  const cards = loadLocalIndex().filter(card =>
    card.local_image &&
    card.art_hash &&
    card.frame_hash &&
    card.title_hash &&
    String(card.layout || "").toLowerCase() !== "token"
  );

  const scan = await hashLocalImageFingerprints(scanImagePath);

  const ctx = {
    guessedName: options.guessedName || "",
    collectorNumber: options.collectorNumber || "",
    detectedSetCode: options.detectedSetCode || "",
    isFoil: !!options.isFoil,
    scan
  };

  const scored = cards.map(card => scoreCandidate(card, ctx));
  scored.sort((a, b) => b._score - a._score);

  const top = scored.slice(0, options.limit || 25);
  const best = top[0] || null;
  const second = top[1] || null;
  const margin = best && second ? (best._score - second._score) : 999;

  return {
    chosen: best,
    second,
    margin,
    pool: top,
    scan
  };
}

module.exports = {
  findBestLocalMatches,
  toPublicImageUrl
};
