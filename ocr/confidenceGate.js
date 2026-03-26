// ocr/confidenceGate.js
const { AUTO_INGEST_MIN_SCORE } = require("./constants");

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function computeOverallScore({
  nameConfidence = 0,
  collectorConfidence = 0,
  hadCollector = false,
  matchCount = 0,
  setSymbolScore = null,
  isPreModernSet = false,    // true for sets released before collector numbers (~pre-1999)
}) {
  const name = clamp01(nameConfidence / 100);
  const coll = clamp01(collectorConfidence / 100);

  let disambig = 0.0;
  if (matchCount === 1) disambig = 1.0;
  else if (matchCount === 2) disambig = 0.85;
  else if (matchCount <= 5) disambig = 0.65;
  else if (matchCount <= 10) disambig = 0.45;
  else disambig = 0.25;

  const symbol = setSymbolScore == null ? 0.0 : clamp01(setSymbolScore);

  let score =
    0.45 * name +
    0.35 * (hadCollector ? coll : 0) +
    0.15 * disambig +
    0.05 * symbol;

  // Only penalize missing collector if the set era actually had them.
  // Pre-1999 sets never printed collector numbers, so absence is expected.
  if (!hadCollector && !isPreModernSet) score *= 0.9;

  return clamp01(score);
}

function shouldAutoIngest(score, minScore = AUTO_INGEST_MIN_SCORE) {
  return Number.isFinite(score) && score >= minScore;
}

module.exports = {
  computeOverallScore,
  shouldAutoIngest,
};
