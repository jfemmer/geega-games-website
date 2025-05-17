const shippoFactory = require('shippo'); // ✅ This is a function

module.exports = async () => {
  const client = shippoFactory(process.env.SHIPPO_TEST_KEY); // ✅ Call it to get the real client
  return client;
};
