function cleanCardName(text) {
  return (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[^A-Za-z0-9 ',-/]/g, "") // keep split cards: Fire // Ice
    .trim();
}

// Updated recognizeWithTimeout: supports passing Tesseract options
function recognizeWithTimeout(imagePath, ms = 30000, tesseractOptions = {}) {
  return Promise.race([
    Tesseract.recognize(imagePath, "eng", tesseractOptions),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`OCR timeout after ${ms}ms`)), ms)
    ),
  ]);
}

async function ocrCardNameHighAccuracy(originalPath, tmpDir) {
  const ts = Date.now();

  const tesseractOptions = {
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-/",
    // extra stability knobs:
    tessedit_ocr_engine_mode: 1,   // LSTM only
    load_system_dawg: 0,
    load_freq_dawg: 0,
    preserve_interword_spaces: 1,
  };

  const offsets = [
    { dx: 0, dy: 0 },
    { dx: 4, dy: 0 }, { dx: -4, dy: 0 },
    { dx: 0, dy: 4 }, { dx: 0, dy: -4 },
    { dx: 6, dy: 2 }, { dx: -6, dy: 2 },
    { dx: 6, dy: -2 }, { dx: -6, dy: -2 },
  ];

  const candidates = [];

  for (let i = 0; i < offsets.length; i++) {
    const { dx, dy } = offsets[i];

    const p1 = path.join(tmpDir, `name_${ts}_o${i}_p1.png`);
    const p2 = path.join(tmpDir, `name_${ts}_o${i}_p2.png`);

    // pass 1
    await cropAndPrepNameBar(originalPath, p1, false, dx, dy);
    const o1 = await recognizeWithTimeout(p1, 90000, tesseractOptions);
    const name1 = cleanCardName(o1?.data?.text);
    const conf1 = o1?.data?.confidence ?? 0;
    if (name1) candidates.push({ name: name1, confidence: conf1 });

    // pass 2 (threshold) if needed
    if (conf1 < 70) {
      await cropAndPrepNameBar(originalPath, p2, true, dx, dy);
      const o2 = await recognizeWithTimeout(p2, 90000, tesseractOptions);
      const name2 = cleanCardName(o2?.data?.text);
      const conf2 = o2?.data?.confidence ?? 0;
      if (name2) candidates.push({ name: name2, confidence: conf2 });
    }
  }

  // Pick best candidate (confidence first, then longer name)
  candidates.sort((a, b) => (b.confidence - a.confidence) || (b.name.length - a.name.length));

  const best = candidates[0] || { name: "", confidence: 0 };
  return best;
}
