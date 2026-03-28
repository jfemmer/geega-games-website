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

// FIX 2: Extract only digit characters from a collector string.
// Used as a fallback comparison when the strict normalized form doesn't match.
// OCR commonly reads "113" when the card says "★113", "C113", or "113p".
// Digit-only comparison catches these without fully trusting noisy OCR.
function digitsOnly(str) {
  return String(str || "").replace(/[^0-9]/g, "");
}

function toPublicImageUrl(localImagePath) {
  if (!localImagePath) return "";
  return `/local_card_images/${path.basename(localImagePath)}`;
}

function fuzzyNameScore(ocrNorm, cardNorm) {
  if (!ocrNorm || !cardNorm) return 0;
  if (ocrNorm === cardNorm) return 1;
  if (cardNorm.startsWith(ocrNorm) || ocrNorm.startsWith(cardNorm)) return 0.85;

  let matches = 0;
  let ci = 0;
  for (let oi = 0; oi < ocrNorm.length && ci < cardNorm.length; oi++) {
    if (ocrNorm[oi] === cardNorm[ci]) { matches++; ci++; }
  }
  return matches / Math.max(ocrNorm.length, cardNorm.length);
}

function scoreCandidate(card, ctx) {
  let score = 0;
  const reasons = [];

  const ocrNameNorm = normalizeName(ctx.guessedName || "");
  const cardNameNorm = normalizeName(card.normalized_name || card.name || "");

  if (ocrNameNorm && cardNameNorm) {
    const ns = fuzzyNameScore(ocrNameNorm, cardNameNorm);
    if (ns >= 1.0) {
      score += 4; reasons.push("exact_name");
    } else if (ns >= 0.85) {
      score += 3; reasons.push("prefix_name");
    } else if (ns >= 0.60) {
      score += 1; reasons.push("fuzzy_name_weak");
    } else {
      reasons.push("name_ignored");
    }
  }

  if (ctx.detectedSetCode) {
    const cardSet = String(card.set || "").toLowerCase();
    const wantSet = String(ctx.detectedSetCode).toLowerCase();
    if (cardSet === wantSet) {
      score += 55; reasons.push("set_symbol_match");
    } else if (ctx.setCodeTrusted) {
      return {
        ...card,
        imageUrl: toPublicImageUrl(card.local_image),
        _score: -9999,
        _distances: { artDist: 9999, frameDist: 9999, titleDist: 9999, fullDist: 9999, symbolDist: 9999 },
        _reasons: ["set_mismatch_hard_reject"]
      };
    } else {
      score -= 25; reasons.push("set_symbol_mismatch_penalty");
    }
  }

  // FIX 2: Collector number comparison — three-tier logic.
  //
  // Tier A (strict): normalized strings match exactly → +60, strong accept.
  // Tier B (digit fallback): normalized strings differ but digit-only forms
  //   match → +30. Handles OCR variants like "★113"→"113" or "C113"→"113".
  //   Only applied when collectorConfidence >= 60 to avoid false positives.
  // Tier C (hard reject): both tiers fail AND confidence is high (>=75).
  //   If confidence is low (<75) we demote to a soft -50 penalty instead of
  //   hard-rejecting — OCR noise should not remove the correct card entirely.
  const scanCollector = normalizeCollector(ctx.collectorNumber || "");
  const cardCollector = normalizeCollector(card.collector_number || "");

  if (scanCollector && cardCollector) {
    if (scanCollector === cardCollector) {
      // Tier A: exact match
      score += 60;
      reasons.push("exact_collector");
    } else {
      // Tier B: digit-only fallback
      const scanDigits = digitsOnly(scanCollector);
      const cardDigits = digitsOnly(cardCollector);
      const digitMatch = scanDigits && cardDigits && scanDigits === cardDigits;
      const collConf = ctx.collectorConfidence ?? 100; // default high if not provided

      if (digitMatch && collConf >= 60) {
        score += 30;
        reasons.push("digit_collector_match");
      } else {
        // Tier C: mismatch — hard reject only when we trust the OCR
        if (collConf >= 75) {
          return {
            ...card,
            imageUrl: toPublicImageUrl(card.local_image),
            _score: -9999,
            _distances: { artDist: 9999, frameDist: 9999, titleDist: 9999, fullDist: 9999, symbolDist: 9999 },
            _reasons: ["collector_mismatch_hard_reject"]
          };
        } else {
          // Low confidence OCR: soft penalty instead of elimination
          score -= 50;
          reasons.push("collector_mismatch_soft_penalty");
        }
      }
    }
  }

  if (ctx.isFoil ? !!card.foil : !!card.nonfoil) {
    score += 10; reasons.push("finish_match");
  }

  const artDist   = hammingHex64(ctx.scan.art_hash,   card.art_hash);
  const frameDist = hammingHex64(ctx.scan.frame_hash, card.frame_hash);
  const titleDist = hammingHex64(ctx.scan.title_hash, card.title_hash);
  const fullDist  = hammingHex64(ctx.scan.full_hash,  card.full_hash);
  const symbolDist =
    ctx.scan.symbol_hash && card.symbol_hash
      ? hammingHex64(ctx.scan.symbol_hash, card.symbol_hash)
      : 9999;

  const isVintage  = (card.released_at || "") < "1999-01-01";
  const isEarlyMod = !isVintage && (card.released_at || "") < "2003-01-01";

  const artPenalty   = isVintage ? 0.8  : isEarlyMod ? 1.2 : 1.8;
  const framePenalty = isVintage ? 1.0  : isEarlyMod ? 1.5 : 2.0;

  score += Math.max(0, 20 - artDist   * artPenalty);
  score += Math.max(0, 26 - frameDist * framePenalty);
  score += Math.max(0, 10 - titleDist * 1.2);
  score += Math.max(0, 8  - fullDist  * 0.8);
  score += Math.max(0, 20 - symbolDist * 1.8);

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
    _distances: { artDist, frameDist, titleDist, fullDist, symbolDist },
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
    // FIX 2: Pre-filter uses digit-only comparison so OCR variants don't
    // incorrectly remove candidates before scoring even starts.
    const cardCollector = normalizeCollector(card.collector_number || "");
    if (!cardCollector) return true;
    return (
      cardCollector === scanCollector ||
      digitsOnly(cardCollector) === digitsOnly(scanCollector)
    );
  });

  const scan = await hashLocalImageFingerprints(scanImagePath);

  const ctx = {
    guessedName:          options.guessedName || "",
    collectorNumber:      options.collectorNumber || "",
    collectorConfidence:  options.collectorConfidence ?? 100,
    detectedSetCode:      options.detectedSetCode || "",
    setCodeTrusted:       !!options.setCodeTrusted,
    isFoil:               !!options.isFoil,
    copyrightYear:        options.copyrightYear || null,
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

  return { chosen: best, second, margin, pool: top, scan };
}

module.exports = {
  findBestLocalMatches,
  toPublicImageUrl
};
