function cleanBottomText(text) {
  return (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCollectorNumberStrict(bottomText) {
  const s = (bottomText || "")
    .replace(/\s+/g, " ")
    .replace(/[|]/g, "/")         // common OCR swap
    .replace(/[^0-9/ ]/g, "")     // keep only digits + slash + spaces
    .trim();

  // Prefer formats like "123/350"
  const m1 = s.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
  if (m1) {
    const n = parseInt(m1[1], 10);
    return Number.isFinite(n) ? String(n) : null;
  }

  // Fallback: standalone number (less safe)
  const m2 = s.match(/\b(\d{1,4})\b/);
  if (m2) {
    const n = parseInt(m2[1], 10);
    return Number.isFinite(n) ? String(n) : null;
  }
  return null;
  }

  async function ocrCollectorNumberHighAccuracy(originalPath, tmpDir) {
    const ts = Date.now();
    const meta = await sharp(originalPath).metadata();
    const W = meta.width;
    const H = meta.height;
  
    const regions = buildCollectorRegions(W, H);
  
    // ✅ Collector number works best as SINGLE_LINE (PSM 7) with numeric whitelist
    const optsStrict = {
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE, // PSM 7
      tessedit_char_whitelist: "0123456789/ ",
    };
  
    // We'll try: each region with (normal + threshold)
    const candidates = [];
  
    for (let i = 0; i < regions.length; i++) {
      const region = regions[i];
  
      const p1 = path.join(tmpDir, `bottom_${ts}_r${i}_p1.png`);
      const p2 = path.join(tmpDir, `bottom_${ts}_r${i}_p2.png`);
  
      try {
        await cropAndPrepBottomLine(originalPath, p1, region, false);
        const o1 = await recognizeWithTimeout(p1, 90000, optsStrict);
        const t1 = cleanBottomText(o1?.data?.text);
        const c1 = o1?.data?.confidence ?? 0;
        const cn1 = parseCollectorNumberStrict(t1);
  
        candidates.push({ regionIndex: i, pass: 1, text: t1, conf: c1, collectorNumber: cn1 });
  
        // Early win: clean parse + decent conf
        if (cn1 && c1 >= 55) {
          // cleanup temp files
          for (const p of [p1, p2]) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
          return { text: t1, confidence: c1, collectorNumber: cn1 };
        }
  
        await cropAndPrepBottomLine(originalPath, p2, region, true);
        const o2 = await recognizeWithTimeout(p2, 90000, optsStrict);
        const t2 = cleanBottomText(o2?.data?.text);
        const c2 = o2?.data?.confidence ?? 0;
        const cn2 = parseCollectorNumberStrict(t2);
  
        candidates.push({ regionIndex: i, pass: 2, text: t2, conf: c2, collectorNumber: cn2 });
  
        if (cn2 && c2 >= 45) {
          for (const p of [p1, p2]) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
          return { text: t2, confidence: c2, collectorNumber: cn2 };
        }
      } finally {
        // cleanup temp files
        for (const p of [p1, p2]) { try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {} }
      }
    }
  
    // Pick best candidate:
    // 1) prefer those that parsed a collector number
    // 2) higher confidence
    candidates.sort((a, b) => (b.collectorNumber ? 1 : 0) - (a.collectorNumber ? 1 : 0) || b.conf - a.conf);
  
    const best = candidates[0] || { text: "", conf: 0, collectorNumber: null };
  
    return {
      text: best.text,
      confidence: best.conf,
      collectorNumber: best.collectorNumber || null,
    };
  }

  module.exports = {
  ocrCollectorNumberHighAccuracy
};
