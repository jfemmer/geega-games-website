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

  if (ocrNameNorm && cardNameNorm) {
    if (ocrNameNorm === cardNameNorm) {
      score += 12;
      reasons.push("exact_name");
    } else if (cardNameNorm.includes(ocrNameNorm) || ocrNameNorm.includes(cardNameNorm)) {
      score += 6;
      reasons.push("partial_name");
    } else {
      reasons.push("name_mismatch_ignored");
    }
  }

  if (ctx.detectedSetCode) {
    if (String(card.set || "").toLowerCase() === String(ctx.detectedSetCode).toLowerCase()) {
      score += 55;
      reasons.push("set_symbol_match");
    } else {
      score -= 25;
      reasons.push("set_symbol_mismatch_penalty");
    }
  }

  const scanCollector = normalizeCollector(ctx.collectorNumber || "");
  const cardCollector = normalizeCollector(card.collector_number || "");

  if (scanCollector && cardCollector) {
    if (scanCollector === cardCollector) {
      score += 60;
      reasons.push("exact_collector");
    } else {
      return {
        ...card,
        imageUrl: toPublicImageUrl(card.local_image),
        _score: -9999,
        _distances: {
          artDist: 9999,
          frameDist: 9999,
          titleDist: 9999,
          fullDist: 9999,
          symbolDist: 9999
        },
        _reasons: ["collector_mismatch_hard_reject"]
      };
    }
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

  // Image evidence should support collector/set, not overpower them
  score += Math.max(0, 20 - artDist * 1.8);
  score += Math.max(0, 26 - frameDist * 2.0);
  score += Math.max(0, 10 - titleDist * 1.2);
  score += Math.max(0, 8 - fullDist * 0.8);
  score += Math.max(0, 20 - symbolDist * 1.8);

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
  ).filter(card => {
    const scanCollector = normalizeCollector(options.collectorNumber || "");
    if (!scanCollector) return true;

    const cardCollector = normalizeCollector(card.collector_number || "");
    return !cardCollector || cardCollector === scanCollector;
  });

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
