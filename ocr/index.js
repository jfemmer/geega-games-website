const { ocrCardNameHighAccuracy } = require("./nameOcr");
const { ocrCollectorNumberHighAccuracy } = require("./collectorOcr");
const { pickPrintingByCollector } = require("./scryfallPicker");
const { computeOverallScore, shouldAutoIngest } = require("./confidenceGate");
const { enqueueForReview } = require("./reviewQueue");

module.exports = {
  ocrCardNameHighAccuracy,
  ocrCollectorNumberHighAccuracy,
  pickPrintingByCollector,
  computeOverallScore,
  shouldAutoIngest,
  enqueueForReview
};
