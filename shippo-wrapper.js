const shippo = require('shippo')(process.env.SHIPPO_TEST_KEY); // ✅ this returns the usable API instance

module.exports = async () => shippo;
