module.exports = async () => {
  const shippoModule = await import('shippo');
  console.log('🚚 Shippo module keys:', Object.keys(shippoModule));

  const shippo = shippoModule.default?.default || shippoModule.default || shippoModule;
  return shippo(process.env.SHIPPO_TEST_KEY);
};
