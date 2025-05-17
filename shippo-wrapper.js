const Shippo = require('shippo');
require('dotenv').config();

const shippo = new Shippo(process.env.SHIPPO_TEST_KEY);
module.exports = shippo;
