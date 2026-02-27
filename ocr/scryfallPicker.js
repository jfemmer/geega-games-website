const axios = require("axios");

function normalizeCollector(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^0+/, ""); // drop leading zeros
}

// Fetch all pages from a Scryfall search endpoint (prints_search_uri is a search)
async function fetchAllScryfallPages(url, maxPages = 20) {
  const all = [];
  let next = url;
  let pages = 0;

  while (next && pages < maxPages) {
    const res = await axios.get(next);
    const data = res.data;

    if (Array.isArray(data?.data)) all.push(...data.data);
    next = data?.has_more ? data?.next_page : null;

    pages++;
  }

  return all;
}

/**
 * pickPrintingByCollector(prints_search_uri, collectorNumber, isFoil)
 * Returns the best matching Scryfall card object, or null.
 */
async function pickPrintingByCollector(printsSearchUri, collectorNumber, isFoil, preferOldest = false, options = {}) {
  const target = normalizeCollector(collectorNumber);
  if (!target) return null;

  const prints = await fetchAllScryfallPages(printsSearchUri);

  // Filter obvious non-cards just in case
  const candidates = prints.filter(c => {
    const lt = (c?.layout || "").toLowerCase();
    const st = (c?.set_type || "").toLowerCase();
    // Keep normal stuff; drop a few “junk” categories that can confuse results
    if (st === "token" || st === "memorabilia" || st === "art_series") return false;
    if (lt === "token") return false;
    return true;
  });

  // 1) Exact collector_number match first (best)
  let exact = candidates.filter(c => normalizeCollector(c.collector_number) === target);

  // 2) If nothing, try matching numeric-only portion (handles OCR oddities like "C 0113")
  if (!exact.length) {
    const targetDigits = target.replace(/[^0-9]/g, "");
    if (targetDigits) {
      exact = candidates.filter(c => {
        const cd = normalizeCollector(c.collector_number).replace(/[^0-9]/g, "");
        return cd === targetDigits;
      });
    }
  }

  // Optional extra disambiguators (pro-level):
  const wantSet = (options.setCode || options.set || null);
  const wantYear = options.year ? parseInt(options.year, 10) : null;

  // If caller provides set code (e.g., from set symbol matching), filter to that set first.
  if (wantSet) {
    const s = String(wantSet).toLowerCase();
    const bySet = exact.filter(c => String(c.set || "").toLowerCase() === s);
    if (bySet.length) exact = bySet;
  }

  // If caller provides a copyright year, narrow candidates by release year window (±1).
  if (Number.isFinite(wantYear) && wantYear > 1900 && wantYear < 2100) {
    const byYear = exact.filter(c => {
      const y = (c.released_at || "").slice(0, 4);
      const yy = parseInt(y, 10);
      if (!Number.isFinite(yy)) return true;
      return Math.abs(yy - wantYear) <= 1;
    });
    if (byYear.length) exact = byYear;
  }

  if (!exact.length) return null;

  // Prefer finish that matches what you’re ingesting
  const want = isFoil ? "foil" : "nonfoil";

  // Scryfall uses "finishes": ["nonfoil","foil","etched",...]
  const finishMatches = exact.filter(c => Array.isArray(c.finishes) && c.finishes.includes(want));
  const pool = finishMatches.length ? finishMatches : exact;

  // If multiple still match, prefer:
  // - English
  // - non-promo over promo
  // - newest/oldest release date (configurable)
  pool.sort((a, b) => {
    const aLang = (a.lang === "en") ? 1 : 0;
    const bLang = (b.lang === "en") ? 1 : 0;
    if (bLang !== aLang) return bLang - aLang;

    const aPromo = a.promo ? 1 : 0;
    const bPromo = b.promo ? 1 : 0;
    if (aPromo !== bPromo) return aPromo - bPromo; // prefer non-promo

    const ad = Date.parse(a.released_at || "1970-01-01");
    const bd = Date.parse(b.released_at || "1970-01-01");

    return preferOldest ? (ad - bd) : (bd - ad);
  });

  const chosen = pool[0] || null;

  if (options && options.returnMeta) {
    return { chosen, matchCount: pool.length, pool };
  }

  return chosen;
}

module.exports = {
  pickPrintingByCollector
};
