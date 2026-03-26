const { ocrCardNameHighAccuracy } = require("./nameOcr");
const { ocrCollectorNumberHighAccuracy } = require("./collectorOcr");
const { ocrSetCodeHighAccuracy } = require("./setCodeOcr");
const { computeOverallScore, shouldAutoIngest } = require("./confidenceGate");
const { enqueueForReview } = require("./reviewQueue");
const { detectSetSymbol, ensureSetSymbolCache } = require("./setSymbolMatcher");
const { ocrCopyrightYear } = require("./copyrightYearOcr");

let findBestLocalMatches = null;

if (process.env.USE_LOCAL === "true") {
  ({ findBestLocalMatches } = require("./localPicker"));
}

module.exports = {
  ocrCardNameHighAccuracy,
  ocrCollectorNumberHighAccuracy,
  ocrSetCodeHighAccuracy,
  ocrCopyrightYear,            // ← add this
  findBestLocalMatches,
  computeOverallScore,
  shouldAutoIngest,
  enqueueForReview,
  detectSetSymbol,
  ensureSetSymbolCache
};
