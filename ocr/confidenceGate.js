// ocr/confidenceGate.js
// FIX 3: Added two new inputs to computeOverallScore:
//   - localMatchMargin: the score gap between best and second-best candidate
//     from localPicker. A large margin is strong evidence the match is correct.
//     Contributes up to +0.07 to the gate score (capped).
//   - exactCollectorMatch: boolean — when collector was found AND matched
//     exactly (not just digit-fallback), give a disproportionate bonus that
//     reflects how uniquely identifying an exact collector number is.
//
// Also: isPreModernSet can now be derived from copyrightYear if the caller
// passes it — no longer relies solely on post-match card.released_at.

const { AUTO_INGEST_MIN_SCORE } = require("./constants");

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function computeOverallScore({
  nameConfidence        = 0,
  collectorConfidence   = 0,
  hadCollector          = false,
  exactCollectorMatch   = false,   // FIX 3: true when collector matched tier-A (exact)
  matchCount            = 0,
  setSymbolScore        = null,
  isPreModernSet        = false,
  copyrightYear         = null,    // FIX 3: if provided, derive isPreModernSet from it
  localMatchMargin      = null,    // FIX 3: score gap between best and second candidate
}) {
  // FIX 3: Derive pre-modern from copyright year when available.
  // copyrightYear is more reliable than post-match card.released_at because
  // it comes from the scan itself, not from a potentially-wrong match.
  const effectivePreModern =
    isPreModernSet ||
    (copyrightYear !== null && Number.isFinite(copyrightYear) && copyrightYear < 1999);

  const name = clamp01(nameConfidence / 100);
  const coll = clamp01(collectorConfidence / 100);

  let disambig = 0.0;
  if (matchCount === 1)       disambig = 1.0;
  else if (matchCount === 2)  disambig = 0.85;
  else if (matchCount <= 5)   disambig = 0.65;
  else if (matchCount <= 10)  disambig = 0.45;
  else                        disambig = 0.25;

  const symbol = setSymbolScore == null ? 0.0 : clamp01(setSymbolScore);

  // FIX 3: Margin component — converts localPicker score gap to 0-1.
  // A margin of 40+ points is very strong; 20 is decent; <10 is ambiguous.
  // Capped contribution: 0.07 (keeps the weights balanced).
  const marginBonus =
    localMatchMargin !== null && Number.isFinite(localMatchMargin)
      ? clamp01(localMatchMargin / 50) * 0.07
      : 0;

  // FIX 3: Exact collector bonus — when the collector number matched exactly
  // (tier-A in localPicker), give a direct additive bonus rather than routing
  // it solely through the coll weight. An exact collector + set match is
  // extremely high confidence and should almost always auto-ingest.
  const exactCollectorBonus = exactCollectorMatch ? 0.06 : 0;

  let score =
    0.38 * name +
    0.32 * (hadCollector ? coll : 0) +
    0.13 * disambig +
    0.10 * symbol +
    marginBonus +
    exactCollectorBonus;

  // Only penalize missing collector for modern sets (they always had them).
  if (!hadCollector && !effectivePreModern) score *= 0.9;

  return clamp01(score);
}

function shouldAutoIngest(score, minScore = AUTO_INGEST_MIN_SCORE) {
  return Number.isFinite(score) && score >= minScore;
}

module.exports = {
  computeOverallScore,
  shouldAutoIngest,
};
