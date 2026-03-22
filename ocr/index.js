const { ocrCardNameHighAccuracy } = require("./nameOcr");
const { ocrCollectorNumberHighAccuracy } = require("./collectorOcr");
const { ocrSetCodeHighAccuracy } = require("./setCodeOcr");
const { computeOverallScore, shouldAutoIngest } = require("./confidenceGate");
const { enqueueForReview } = require("./reviewQueue");
const { detectSetSymbol, ensureSetSymbolCache } = require("./setSymbolMatcher");

let findBestLocalMatches = null;

if (process.env.USE_LOCAL === "true") {
  ({ findBestLocalMatches } = require("./localPicker"));
}

module.exports = {
  ocrCardNameHighAccuracy,
  ocrCollectorNumberHighAccuracy,
  ocrSetCodeHighAccuracy,
  findBestLocalMatches,
  computeOverallScore,
  shouldAutoIngest,
  enqueueForReview,
  detectSetSymbol,
  ensureSetSymbolCache
};
