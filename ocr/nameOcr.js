const path = require("path");
const fs = require("fs");
const Tesseract = require("tesseract.js");
const { cropAndPrepNameBar } = require("./imageUtils");

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

  // ✅ Ensure tmpDir exists (refactors often break this)
  try {
    if (!tmpDir) throw new Error("tmpDir is missing");
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    console.log("🔴 [nameOcr] tmpDir mkdir failed:", tmpDir, e.message);
    // If we can't write crops, OCR will be unreliable; fail fast.
    return { name: "", confidence: 0, error: "tmpDir_not_writable" };
  }

  // ✅ Sanity: input exists
  try {
    if (!fs.existsSync(originalPath)) {
      console.log("🔴 [nameOcr] originalPath missing:", originalPath);
      return { name: "", confidence: 0, error: "input_missing" };
    }
  } catch {}

  const tesseractOptions = {
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist:
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-/",
    // extra stability knobs:
    tessedit_ocr_engine_mode: 1, // LSTM only
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
    try {
      console.log("🟣 [nameOcr] cropping name bar ->", { p1, dx, dy });
      await cropAndPrepNameBar(originalPath, p1, false, dx, dy);

      if (!fs.existsSync(p1)) {
        console.log("🔴 [nameOcr] crop did not write file (p1):", p1);
        continue;
      }

      console.log("🟣 [nameOcr] crop saved ->", p1);
    } catch (e) {
      console.log("🔴 [nameOcr] cropAndPrepNameBar failed (p1):", e.message);
      continue; // skip OCR for this offset
    }

    let o1;
    try {
      o1 = await recognizeWithTimeout(p1, 90000, tesseractOptions);
    } catch (e) {
      console.log("🔴 [nameOcr] Tesseract failed (p1):", e.message);
      continue;
    }

    const name1 = cleanCardName(o1?.data?.text);
    const conf1 = o1?.data?.confidence ?? 0;
    if (name1) candidates.push({ name: name1, confidence: conf1 });

    // pass 2 (threshold) if needed
    if (conf1 < 70) {
      try {
        console.log("🟣 [nameOcr] cropping name bar (threshold) ->", { p2, dx, dy });
        await cropAndPrepNameBar(originalPath, p2, true, dx, dy);

        if (!fs.existsSync(p2)) {
          console.log("🔴 [nameOcr] crop did not write file (p2):", p2);
          continue;
        }

        console.log("🟣 [nameOcr] crop saved ->", p2);
      } catch (e) {
        console.log("🔴 [nameOcr] cropAndPrepNameBar failed (p2):", e.message);
        continue;
      }

      try {
        const o2 = await recognizeWithTimeout(p2, 90000, tesseractOptions);
        const name2 = cleanCardName(o2?.data?.text);
        const conf2 = o2?.data?.confidence ?? 0;
        if (name2) candidates.push({ name: name2, confidence: conf2 });
      } catch (e) {
        console.log("🔴 [nameOcr] Tesseract failed (p2):", e.message);
      }
    }
  }

  // Pick best candidate (confidence first, then longer name)
  candidates.sort(
    (a, b) => (b.confidence - a.confidence) || (b.name.length - a.name.length)
  );

  const best = candidates[0] || { name: "", confidence: 0 };

  // Helpful debug when everything fails
  if (!best.name) {
    console.log("⚠️ [nameOcr] No candidates produced", {
      originalPath,
      tmpDir,
      candidatesCount: candidates.length
    });
  }

  return best;
}

module.exports = {
  ocrCardNameHighAccuracy,
  recognizeWithTimeout
};
