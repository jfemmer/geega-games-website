// ocr/setSymbolMatcher.js
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { SYMBOL_OFFSETS } = require("./constants");
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
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
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

  cache = {
    generatedAt: new Date().toISOString(),
    entries
  };

  writeCache(cache);
  return cache;
}

function distanceToScore(dist) {
  if (!Number.isFinite(dist)) return 0;

  if (dist <= 4) return 1.0;
  if (dist <= 6) return 0.93;
  if (dist <= 8) return 0.80;
  if (dist <= 10) return 0.60;
  if (dist <= 12) return 0.40;

  return 0.20;
}

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

  const pool = allowedSetCodes
    ? entries.filter(e => allowedSetCodes.has(e.setCode))
    : entries;

    console.log("🧩 [symbol] cache status", {
        entries: entries.length,
        pool: pool.length
    });

  if (!pool.length) {
    return {
      setCode: null,
      score: 0,
      bestDist: 9999,
      scanHash: null,
      top: []
    };
  }

  let best = null;
  const scored = [];

  for (const { dx, dy } of SYMBOL_OFFSETS) {
    let scanHash = null;

   try {
    const fs = require("fs");
    const path = require("path");

    const debugDir = path.join(__dirname, "..", "ocr_debug");
    if (!fs.existsSync(debugDir)) fs.mkdirSync(debugDir, { recursive: true });

    let scanHash = null;

    try {
      // 👇 NEW: also get the cropped buffer
      const { hash, buffer } = await hashScanSetSymbol(imagePath, dx, dy, true);

      scanHash = hash;

      // 👇 Save the actual crop
      const debugPath = path.join(
        debugDir,
        `symbol_${Date.now()}_${dx}_${dy}.png`
      );

      fs.writeFileSync(debugPath, buffer);

      console.log("🟡 [symbol] crop saved ->", debugPath);

    } catch (err) {
      console.log("🧩 [symbol] hashScanSetSymbol failed", {
        dx,
        dy,
        error: err?.message || String(err)
      });
      continue;
    }
    } catch (err) {
    console.log("🧩 [symbol] hashScanSetSymbol failed", {
        dx,
        dy,
        error: err?.message || String(err)
    });
    continue;
    }

    for (const entry of pool) {
      const dist = hammingHex64(scanHash, entry.hash);
      const weight = (dx === 0 && dy === 0) ? 0 : 0.5;
      const weightedDist = dist + weight;

      const row = {
        setCode: entry.setCode,
        setName: entry.setName,
        setType: entry.setType,
        releasedAt: entry.releasedAt,
        dx,
        dy,
        dist,
        weightedDist
      };

      scored.push(row);

      if (!best || weightedDist < best.weightedDist) {
        best = { ...row, scanHash };
      }
    }
  }

  if (!best) {
    return {
      setCode: null,
      score: 0,
      bestDist: 9999,
      scanHash: null,
      top: []
    };
  }

  scored.sort((a, b) => a.weightedDist - b.weightedDist || a.dist - b.dist);

  console.log("🟡 [symbol] top matches:", scored.slice(0, 5));

  if (best.dist > 12) {
    return {
      setCode: null,
      score: 0,
      bestDist: best.dist,
      scanHash: best.scanHash,
      top: scored.slice(0, 5)
    };
  }

  const second = scored[1];
  if (second && Math.abs(second.dist - best.dist) <= 1) {
    return {
      setCode: null,
      score: 0.4,
      bestDist: best.dist,
      scanHash: best.scanHash,
      top: scored.slice(0, 5)
    };
  }

  if (process.env.DEBUG_SYMBOL === "true") {
    console.log("🧩 Symbol Match:", {
      best: best.setCode,
      dist: best.dist,
      weightedDist: best.weightedDist,
      top: scored.slice(0, 3)
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

module.exports = {
  ensureSetSymbolCache,
  detectSetSymbol
};
