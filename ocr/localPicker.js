const path = require("path");
const fs = require("fs");
const { hashScanArtwork, hammingHex64, dhash64FromBuffer } = require("./imageHash");
const { getHash, setHash } = require("./hashCache");
const sharp = require("sharp");

const LOCAL_INDEX_PATH =
  process.env.LOCAL_INDEX_PATH || "D:/MTG_DATA/scryfall/local_index.json";

let LOCAL_INDEX_CACHE = null;

function loadLocalIndex() {
  if (LOCAL_INDEX_CACHE) return LOCAL_INDEX_CACHE;
  LOCAL_INDEX_CACHE = JSON.parse(fs.readFileSync(LOCAL_INDEX_PATH, "utf8"));
  return LOCAL_INDEX_CACHE;
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

function buildCandidatePool(name, options = {}) {
  const cards = loadLocalIndex();
  const targetName = String(name || "").toLowerCase().trim();
  const targetSet = String(options.setCode || "").toLowerCase().trim();

  let pool = cards.filter(card =>
    String(card.name || "").toLowerCase() === targetName
  );

  if (targetSet) {
    const bySet = pool.filter(card => String(card.set || "").toLowerCase() === targetSet);
    if (bySet.length) pool = bySet;
  }

  return pool;
}

function pickPrintingByCollectorLocal(name, collectorNumber, isFoil, options = {}) {
  const target = normalizeCollector(collectorNumber);
  if (!target) return { chosen: null, matchCount: 0, pool: [] };

  let pool = buildCandidatePool(name, options);

  pool = pool.filter(card => String(card.layout || "").toLowerCase() !== "token");

  let exact = pool.filter(card =>
    normalizeCollector(card.collector_number) === target
  );

  if (!exact.length) {
    const targetDigits = target.replace(/[^0-9]/g, "");
    if (targetDigits) {
      exact = pool.filter(card => {
        const cd = normalizeCollector(card.collector_number).replace(/[^0-9]/g, "");
        return cd === targetDigits;
      });
    }
  }

  if (!exact.length) {
    return { chosen: null, matchCount: 0, pool: [] };
  }

  const finishMatches = exact.filter(card => {
    if (isFoil) return !!card.foil;
    return !!card.nonfoil;
  });

  const finalPool = finishMatches.length ? finishMatches : exact;

  finalPool.sort((a, b) => {
    const aLang = a.lang === "en" ? 1 : 0;
    const bLang = b.lang === "en" ? 1 : 0;
    if (bLang !== aLang) return bLang - aLang;
    return String(a.set_name || "").localeCompare(String(b.set_name || ""));
  });

  const chosen = finalPool[0]
    ? {
        ...finalPool[0],
        imageUrl: toPublicImageUrl(finalPool[0].local_image)
      }
    : null;

  return {
    chosen,
    matchCount: finalPool.length,
    pool: finalPool.map(card => ({
      ...card,
      imageUrl: toPublicImageUrl(card.local_image)
    }))
  };
}

async function hashLocalArtworkFromPath(imagePath) {
  const meta = await sharp(imagePath).metadata();
  const W = meta.width;
  const H = meta.height;

  const artBuf = await sharp(imagePath)
    .extract({
      left: Math.floor(W * 0.11),
      top: Math.floor(H * 0.17),
      width: Math.floor(W * 0.78),
      height: Math.floor(H * 0.40),
    })
    .grayscale()
    .normalize()
    .toBuffer();

  return await dhash64FromBuffer(artBuf);
}

async function refineByArtworkHashLocal(scanImagePath, candidates, opts = {}) {
  if (!scanImagePath || !Array.isArray(candidates) || candidates.length === 0) {
    return { chosen: null, bestDist: 9999, scored: [] };
  }

  const scanHash = await hashScanArtwork(scanImagePath);

  let best = null;
  let bestDist = 9999;
  const scored = [];

  for (const c of candidates) {
    const key = c?.id || c?.local_image;
    if (!key || !c?.local_image || !fs.existsSync(c.local_image)) continue;

    let h = getHash(key);
    if (!h) {
      h = await hashLocalArtworkFromPath(c.local_image);
      setHash(key, h);
    }

    const d = hammingHex64(scanHash, h);
    scored.push({
      id: c.id,
      set: c.set,
      collector: c.collector_number,
      dist: d
    });

    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }

  const maxDist = opts.maxDist ?? 8;
  if (!best || bestDist > maxDist) {
    return { chosen: null, bestDist, scored };
  }

  return { chosen: best, bestDist, scored };
}

module.exports = {
  pickPrintingByCollectorLocal,
  refineByArtworkHashLocal,
  toPublicImageUrl
};
