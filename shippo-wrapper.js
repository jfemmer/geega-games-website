module.exports = async () => {
  const shippoModule = await import('shippo');
  const Shippo = shippoModule.Shippo || shippoModule.default?.Shippo;

  if (!Shippo) {
    throw new Error('Shippo constructor not found in module export');
  }

  return new Shippo(process.env.SHIPPO_TEST_KEY);
};
