// ocr/setSymbolMatcher.js
// FIX 4: Two changes to set symbol detection:
//
//   A) SYMBOL_OFFSETS replaced inline with a wider y-axis jitter.
//      The set symbol sits in the type-line bar, whose vertical position
//      shifts 5–15px depending on card type (creatures have taller art boxes
//      than instants/sorceries). The original ±2px offsets were not enough.
//      New offsets: dy ∈ {0, -4, 4, -8, 8} — x offsets dropped (x is stable).
//
//   B) Tie-breaking: when the top two symbol candidates are within 1 Hamming
//      distance of each other the original code returned setCode=null.
//      Now, if a trusted setCodeOcrValue is provided, it is used to break
//      the tie. If neither candidate matches the OCR value the tie stands.

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const {
  hashScanSetSymbol,
  hashReferenceSymbolBuffer,
  hammingHex64
} = require("./imageHash");

const CACHE_PATH = process.env.RAILWAY_ENVIRONMENT
  ? "/tmp/scryfall_set_symbol_hash_cache.json"
  : path.join(__dirname, "..", "scryfall_set_symbol_hash_cache.json");

let cache = null;

function readCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {}
  return null;
}

function writeCache(obj) {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2), "utf8"); } catch {}
}

async function fetchAllSets() {
  const res = await axios.get("https://api.scryfall.com/sets");
  return Array.isArray(res?.data?.data) ? res.data.data : [];
}

async function ensureSetSymbolCache(forceRefresh = false) {
  if (cache && !forceRefresh) return cache;

  if (!forceRefresh) {
    const existing = readCache();
    if (existing?.generatedAt && Array.isArray(existing?.entries) && existing.entries.length) {
      cache = existing;
      return cache;
    }
  }

  const sets = await fetchAllSets();
  const entries = [];

  for (const set of sets) {
    const setCode = String(set?.code || "").trim().toLowerCase();
    const iconSvgUri = String(set?.icon_svg_uri || "").trim();
    if (!setCode || !iconSvgUri) continue;

    try {
      const iconRes = await axios.get(iconSvgUri, { responseType: "arraybuffer" });
      const hash = await hashReferenceSymbolBuffer(Buffer.from(iconRes.data));
      entries.push({
        setCode,
        setName: set?.name || "",
        setType: set?.set_type || "",
        releasedAt: set?.released_at || "",
        hash
      });
    } catch {
      // keep going; one bad icon should not stop the cache build
    }
  }

  cache = { generatedAt: new Date().toISOString(), entries };
  writeCache(cache);
  return cache;
}

function distanceToScore(dist) {
  if (!Number.isFinite(dist)) return 0;
  if (dist <= 4)  return 1.0;
  if (dist <= 6)  return 0.93;
  if (dist <= 8)  return 0.80;
  if (dist <= 10) return 0.60;
  if (dist <= 12) return 0.40;
  return 0.20;
}

// FIX 4A: Expanded y-jitter offsets. X position of the set symbol is
// essentially fixed; y shifts with card type. Cover ±8px in y only.
const EXPANDED_SYMBOL_OFFSETS = [
  { dx: 0, dy:  0 },
  { dx: 0, dy: -4 },
  { dx: 0, dy:  4 },
  { dx: 0, dy: -8 },
  { dx: 0, dy:  8 },
];

async function detectSetSymbol(imagePath, opts = {}) {
  const data = await ensureSetSymbolCache(Boolean(opts.forceRefresh));
  const entries = Array.isArray(data?.entries) ? data.entries : [];

  const allowedSetCodes = Array.isArray(opts.allowedSetCodes)
    ? new Set(
        opts.allowedSetCodes
          .map(x => String(x || "").trim().toLowerCase())
          .filter(Boolean)
      )
    : null;

  const pool = (allowedSetCodes && allowedSetCodes.size > 0)
    ? entries.filter(e => allowedSetCodes.has(e.setCode))
    : entries;

  console.log("🧩 [symbol] cache status", { entries: entries.length, pool: pool.length });

  if (!pool.length) {
    return { setCode: null, score: 0, bestDist: 9999, scanHash: null, top: [] };
  }

  let best = null;
  const scored = [];

  const debugDir = path.join(__dirname, "..", "ocr_debug");
  try { fs.mkdirSync(debugDir, { recursive: true }); } catch {}

  for (const { dx, dy } of EXPANDED_SYMBOL_OFFSETS) {
    let scanHash = null;

    try {
      const { hash, buffer } = await hashScanSetSymbol(imagePath, dx, dy, true);
      scanHash = hash;

      const debugPath = path.join(debugDir, `symbol_${Date.now()}_dx${dx}_dy${dy}.png`);
      fs.writeFileSync(debugPath, buffer);
      console.log("🟡 [symbol] crop saved ->", debugPath);
    } catch (err) {
      console.log("🧩 [symbol] hashScanSetSymbol failed", { dx, dy, error: err?.message || String(err) });
      continue;
    }

    for (const entry of pool) {
      const dist = hammingHex64(scanHash, entry.hash);
      // Weight centre offset as 0 (no penalty), jitter offsets as +0.5.
      const weight = (dx === 0 && dy === 0) ? 0 : 0.5;
      const weightedDist = dist + weight;

      const row = {
        setCode: entry.setCode,
        setName: entry.setName,
        setType: entry.setType,
        releasedAt: entry.releasedAt,
        dx, dy, dist, weightedDist
      };

      scored.push(row);

      if (!best || weightedDist < best.weightedDist) {
        best = { ...row, scanHash };
      }
    }
  }

  if (!best) {
    return { setCode: null, score: 0, bestDist: 9999, scanHash: null, top: [] };
  }

  scored.sort((a, b) => a.weightedDist - b.weightedDist || a.dist - b.dist);

  console.log("🟡 [symbol] top matches:", scored.slice(0, 5));

  if (best.dist > 12) {
    return {
      setCode: null, score: 0,
      bestDist: best.dist, scanHash: best.scanHash,
      top: scored.slice(0, 5)
    };
  }

  const second = scored[1];
  const isTie = second && Math.abs(second.dist - best.dist) <= 1;

  if (isTie) {
    // FIX 4B: Use setCodeOcrValue as a tiebreaker when the hashes are
    // ambiguous. If the OCR set code matches one of the two tied candidates,
    // promote that candidate. If neither matches, the tie stands (no setCode).
    const ocrHint = String(opts.setCodeOcrValue || "").trim().toLowerCase();

    if (ocrHint) {
      const bestMatchesOcr   = best.setCode   === ocrHint;
      const secondMatchesOcr = second.setCode === ocrHint;

      if (bestMatchesOcr && !secondMatchesOcr) {
        // OCR confirms best — treat as resolved
        console.log(`🟡 [symbol] Tie broken by OCR hint "${ocrHint}" → ${best.setCode}`);
        return {
          setCode: best.setCode,
          score: distanceToScore(best.dist) * 0.85, // slight discount for tie context
          bestDist: best.dist, scanHash: best.scanHash,
          top: scored.slice(0, 5)
        };
      }

      if (secondMatchesOcr && !bestMatchesOcr) {
        console.log(`🟡 [symbol] Tie broken by OCR hint "${ocrHint}" → ${second.setCode}`);
        return {
          setCode: second.setCode,
          score: distanceToScore(second.dist) * 0.85,
          bestDist: second.dist, scanHash: best.scanHash,
          top: scored.slice(0, 5)
        };
      }
    }

    // Tie unresolved — return ambiguous result (original behaviour)
    return {
      setCode: null, score: 0.4,
      bestDist: best.dist, scanHash: best.scanHash,
      top: scored.slice(0, 5)
    };
  }

  if (process.env.DEBUG_SYMBOL === "true") {
    console.log("🧩 Symbol Match:", {
      best: best.setCode, dist: best.dist,
      weightedDist: best.weightedDist, top: scored.slice(0, 3)
    });
  }

  return {
    setCode: best.setCode,
    score: distanceToScore(best.dist),
    bestDist: best.dist,
    scanHash: best.scanHash,
    top: scored.slice(0, 5)
  };
}

module.exports = { ensureSetSymbolCache, detectSetSymbol };
