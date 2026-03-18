const { ocrCardNameHighAccuracy } = require("./nameOcr");
const { ocrCollectorNumberHighAccuracy } = require("./collectorOcr");
const { pickPrintingByCollector, refineByArtworkHash } = require("./scryfallPicker");
const { computeOverallScore, shouldAutoIngest } = require("./confidenceGate");
const { enqueueForReview } = require("./reviewQueue");
const { detectSetSymbol, ensureSetSymbolCache } = require("./setSymbolMatcher");

module.exports = {
  ocrCardNameHighAccuracy,
  ocrCollectorNumberHighAccuracy,
  pickPrintingByCollector,
  refineByArtworkHash,
  computeOverallScore,
  shouldAutoIngest,
  enqueueForReview,
  detectSetSymbol,
  ensureSetSymbolCache
};
