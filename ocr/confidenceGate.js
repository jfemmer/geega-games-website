// ocr/confidenceGate.js
const { AUTO_INGEST_MIN_SCORE } = require("./constants");

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * Computes an overall confidence score for auto-ingest decisions.
 * This is NOT "OCR confidence only" — it rewards disambiguation strength.
 */
function computeOverallScore({
  nameConfidence = 0,        // 0..100 (tesseract)
  collectorConfidence = 0,   // 0..100 (tesseract)
  hadCollector = false,      // boolean
  matchCount = 0,            // how many printings still match after filters
  setSymbolScore = null,     // 0..1 if you add set symbol matching later
}) {
  const name = clamp01(nameConfidence / 100);
  const coll = clamp01(collectorConfidence / 100);

  // Disambiguation: unique match is best; 2 is okay; many is risky
  let disambig = 0.0;
  if (matchCount === 1) disambig = 1.0;
  else if (matchCount === 2) disambig = 0.85;
  else if (matchCount <= 5) disambig = 0.65;
  else if (matchCount <= 10) disambig = 0.45;
  else disambig = 0.25;

  const symbol = setSymbolScore == null ? 0.0 : clamp01(setSymbolScore);

  // Weighted sum (tune via logs)
  let score =
    0.45 * name +
    0.35 * (hadCollector ? coll : 0) +
    0.15 * disambig +
    0.05 * symbol;

  // If we don't have a collector number, cap score a bit (print ambiguity risk)
  if (!hadCollector) score *= 0.9;

  return clamp01(score);
}

function shouldAutoIngest(score, minScore = AUTO_INGEST_MIN_SCORE) {
  return Number.isFinite(score) && score >= minScore;
}

module.exports = {
  computeOverallScore,
  shouldAutoIngest,
};
