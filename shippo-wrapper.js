const shippo = require('shippo');

module.exports = async () => {
  return shippo(process.env.SHIPPO_TEST_KEY);
};
