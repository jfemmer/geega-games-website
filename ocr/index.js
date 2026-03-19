const { ocrCardNameHighAccuracy } = require("./nameOcr");
const { ocrCollectorNumberHighAccuracy } = require("./collectorOcr");
const { pickPrintingByCollectorLocal, refineByArtworkHashLocal } = require("./localPicker");
const { computeOverallScore, shouldAutoIngest } = require("./confidenceGate");
const { enqueueForReview } = require("./reviewQueue");
const { detectSetSymbol, ensureSetSymbolCache } = require("./setSymbolMatcher");

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
