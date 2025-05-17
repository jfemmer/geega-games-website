const shippo = require('shippo')(process.env.SHIPPO_TEST_KEY);
require('dotenv').config();

module.exports = shippo;
