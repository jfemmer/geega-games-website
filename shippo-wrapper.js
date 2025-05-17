module.exports = async () => {
  const { default: Shippo } = await import('shippo');
  return new Shippo(process.env.SHIPPO_TEST_KEY);
};
