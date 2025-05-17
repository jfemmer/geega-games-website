module.exports = async () => {
  const shippoModule = await import('shippo');
  const createClient = shippoModule.createClient || shippoModule.default?.createClient;

  if (!createClient) {
    throw new Error('❌ Shippo SDK: createClient function not found.');
  }

  return createClient(process.env.SHIPPO_TEST_KEY);
};
