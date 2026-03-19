const { ocrCardNameHighAccuracy } = require("./nameOcr");
const { ocrCollectorNumberHighAccuracy } = require("./collectorOcr");
const { computeOverallScore, shouldAutoIngest } = require("./confidenceGate");
const { enqueueForReview } = require("./reviewQueue");
const { detectSetSymbol, ensureSetSymbolCache } = require("./setSymbolMatcher");

let pickPrintingByCollectorLocal = null;
let refineByArtworkHashLocal = null;

if (process.env.USE_LOCAL === "true") {
  ({ pickPrintingByCollectorLocal, refineByArtworkHashLocal } = require("./localPicker"));
}

module.exports = {
  ocrCardNameHighAccuracy,
  ocrCollectorNumberHighAccuracy,
  pickPrintingByCollectorLocal,
  refineByArtworkHashLocal,
  computeOverallScore,
  shouldAutoIngest,
  enqueueForReview,
  detectSetSymbol,
  ensureSetSymbolCache
};
