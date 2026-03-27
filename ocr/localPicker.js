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

// C13: Fuzzy name match for old-frame cards where OCR often garbles
// a few characters. Returns 0-1 score based on how many characters of
// the OCR result appear in the card name in order (longest common subsequence
// as a fraction of the shorter string). Used only as a soft signal.
function fuzzyNameScore(ocrNorm, cardNorm) {
  if (!ocrNorm || !cardNorm) return 0;
  if (ocrNorm === cardNorm) return 1;

  // Exact prefix match is very strong for garbled OCR
  if (cardNorm.startsWith(ocrNorm) || ocrNorm.startsWith(cardNorm)) return 0.85;

  // Count character overlap (rough LCS approximation)
  let matches = 0;
  let ci = 0;
  for (let oi = 0; oi < ocrNorm.length && ci < cardNorm.length; oi++) {
    if (ocrNorm[oi] === cardNorm[ci]) {
      matches++;
      ci++;
    }
  }
  return matches / Math.max(ocrNorm.length, cardNorm.length);
}

function scoreCandidate(card, ctx) {
  let score = 0;
  const reasons = [];

  const ocrNameNorm = normalizeName(ctx.guessedName || "");
  const cardNameNorm = normalizeName(card.normalized_name || card.name || "");

  // C13: Use fuzzy name matching instead of exact-only.
  // Old-frame OCR regularly garbles 1-3 chars so exact match is too strict.
  // Score scale: exact=4, near-exact=3, partial=1-2, no match=0.
  if (ocrNameNorm && cardNameNorm) {
    const ns = fuzzyNameScore(ocrNameNorm, cardNameNorm);
    if (ns >= 1.0) {
      score += 4;
      reasons.push("exact_name");
    } else if (ns >= 0.85) {
      score += 3;
      reasons.push("prefix_name");
    } else if (ns >= 0.60) {
      score += 1;
      reasons.push("fuzzy_name_weak");
    } else {
      reasons.push("name_ignored");
    }
  }

  if (ctx.detectedSetCode) {
    const cardSet = String(card.set || "").toLowerCase();
    const wantSet = String(ctx.detectedSetCode).toLowerCase();
    if (cardSet === wantSet) {
      score += 55;
      reasons.push("set_symbol_match");
    } else if (ctx.setCodeTrusted) {
      return {
        ...card,
        imageUrl: toPublicImageUrl(card.local_image),
        _score: -9999,
        _distances: { artDist: 9999, frameDist: 9999, titleDist: 9999, fullDist: 9999, symbolDist: 9999 },
        _reasons: ["set_mismatch_hard_reject"]
      };
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

  const artDist   = hammingHex64(ctx.scan.art_hash,   card.art_hash);
  const frameDist = hammingHex64(ctx.scan.frame_hash, card.frame_hash);
  const titleDist = hammingHex64(ctx.scan.title_hash, card.title_hash);
  const fullDist  = hammingHex64(ctx.scan.full_hash,  card.full_hash);
  const symbolDist =
    ctx.scan.symbol_hash && card.symbol_hash
      ? hammingHex64(ctx.scan.symbol_hash, card.symbol_hash)
      : 9999;

  // C13: Old cards (pre-2003) have faded/yellowed art that drifts further from
  // Scryfall reference scans than modern cards. The penalty slope is reduced so
  // a high art distance doesn't completely bury the correct old printing.
  // Pre-1999 (vintage) gets the softest penalty; 1999-2003 gets a medium penalty.
  const isVintage    = (card.released_at || "") < "1999-01-01";
  const isEarlyMod   = !isVintage && (card.released_at || "") < "2003-01-01";

  const artPenalty   = isVintage ? 0.8  : isEarlyMod ? 1.2 : 1.8;
  const framePenalty = isVintage ? 1.0  : isEarlyMod ? 1.5 : 2.0;

  score += Math.max(0, 20 - artDist   * artPenalty);
  score += Math.max(0, 26 - frameDist * framePenalty);
  score += Math.max(0, 10 - titleDist * 1.2);
  score += Math.max(0, 8  - fullDist  * 0.8);
  score += Math.max(0, 20 - symbolDist * 1.8);

  // Copyright year bonus — strongest signal for old printings.
  // yearDiff=0: +30 points (very strong)
  // yearDiff=1: +15 points (strong, e.g. card printed Dec 1993, released Jan 1994)
  // yearDiff=2: +5  points (weak corroboration, handles delayed releases)
  if (ctx.copyrightYear && card.released_at) {
    const cardYear = parseInt((card.released_at || "").slice(0, 4), 10);
    if (Number.isFinite(cardYear)) {
      const yearDiff = Math.abs(cardYear - ctx.copyrightYear);
      if (yearDiff === 0)      { score += 30; reasons.push("copyright_year_exact"); }
      else if (yearDiff === 1) { score += 15; reasons.push("copyright_year_near"); }
      else if (yearDiff === 2) { score += 5;  reasons.push("copyright_year_close"); }
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
    guessedName:     options.guessedName || "",
    collectorNumber: options.collectorNumber || "",
    detectedSetCode: options.detectedSetCode || "",
    setCodeTrusted:  !!options.setCodeTrusted,
    isFoil:          !!options.isFoil,
    copyrightYear:   options.copyrightYear || null,
    scan
  };

  const scored = cards
    .map(card => scoreCandidate(card, ctx))
    .filter(card => Number.isFinite(card?._score) && card._score > -9999);

  scored.sort((a, b) => b._score - a._score);

  const top    = scored.slice(0, options.limit || 25);
  const best   = top[0] || null;
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
