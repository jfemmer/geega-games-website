const { ocrCardNameHighAccuracy } = require("./nameOcr");
const { ocrCollectorNumberHighAccuracy } = require("./collectorOcr");
const { pickPrintingByCollector } = require("./scryfallPicker");

module.exports = {
  ocrCardNameHighAccuracy,
  ocrCollectorNumberHighAccuracy,
  pickPrintingByCollector
};
