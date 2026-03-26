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

  // OCR name is only a very weak hint now
  if (ocrNameNorm && cardNameNorm) {
    if (ocrNameNorm === cardNameNorm) {
      score += 4;
      reasons.push("exact_name_weak");
    } else {
      reasons.push("name_ignored");
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

  // Old cards (pre-2003) have faded/yellowed art that drifts from Scryfall
  // reference scans. Use a softer distance penalty so aged prints aren't unfairly
  // ranked below reprints with cleaner reference images.
  const isVintage = (card.released_at || "") < "2003-01-01";
  const artPenalty   = isVintage ? 1.0 : 1.8;
  const framePenalty = isVintage ? 1.3 : 2.0;

  score += Math.max(0, 20 - artDist   * artPenalty);
  score += Math.max(0, 26 - frameDist * framePenalty);
  score += Math.max(0, 10 - titleDist * 1.2);
  score += Math.max(0, 8  - fullDist  * 0.8);
  score += Math.max(0, 20 - symbolDist * 1.8);

  // Copyright year bonus: if the OCR year matches the card's release year (±1),
  // that's strong corroborating evidence for old printings.
  if (ctx.copyrightYear && card.released_at) {
    const cardYear = parseInt((card.released_at || "").slice(0, 4), 10);
    if (Number.isFinite(cardYear)) {
      const yearDiff = Math.abs(cardYear - ctx.copyrightYear);
      if (yearDiff === 0) { score += 30; reasons.push("copyright_year_exact"); }
      else if (yearDiff === 1) { score += 15; reasons.push("copyright_year_near"); }
    }
  }

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
  card.full_hash &&
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
    copyrightYear: options.copyrightYear || null,   // ← new
    scan
  };

  const scored = cards
  .map(card => scoreCandidate(card, ctx))
  .filter(card => Number.isFinite(card?._score) && card._score > -9999);

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
