module.exports = async () => {
  const shippoModule = await import('shippo');
  const shippo = shippoModule.default; // default export is the function
  return shippo(process.env.SHIPPO_TEST_KEY); // ✅ CALL, don't use `new`
};
