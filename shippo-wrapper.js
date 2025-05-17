module.exports = async () => {
  const { default: shippoInit } = await import('shippo');
  return shippoInit(process.env.SHIPPO_TEST_KEY);
};
