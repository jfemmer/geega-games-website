const shippo = require('shippo');
console.log('🧪 typeof shippo:', typeof shippo);
console.log('🧪 shippo keys:', Object.keys(shippo));

module.exports = async () => {
  return shippo; // Do NOT try to call it
};
