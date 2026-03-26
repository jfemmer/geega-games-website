// ocr/copyrightYearOcr.js
// Extracts the copyright year from the bottom-right info line of a scanned card.
//
// Old MTG cards (pre-~2003) print a copyright year here, e.g. "© 1994"
// or "TM & © 1993 Wizards of the Coast". This year is the single most
// reliable signal for narrowing down which printing an old card belongs to.
//
// Region: bottom-right quadrant of the card, same vertical band as collector number.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");
const { acquireWorker, releaseWorker, recognizeWithTimeout } = require("./nameOcr");

function buildCopyrightRegion(W, H) {
  return {
    left:   Math.floor(W * 0.50),   // right half of card
    top:    Math.floor(H * 0.915),  // same vertical band as collector number
    width:  Math.floor(W * 0.44),   // wide — copyright text can be long
    height: Math.floor(H * 0.040),  // two-line safe height
  };
}

// Whitelist: copyright symbol alternatives, digits, letters, spaces.
// We intentionally keep letters so "Wizards" doesn't confuse the year parser.
const COPYRIGHT_OPTS = {
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  tessedit_char_whitelist: "©TMtm&0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .",
};

function parseCopyrightYear(text) {
  if (!text) return null;
  // Match 4-digit years in the range 1990–2015 (modern cards post-2015 use
  // a different format and don't need year-based disambiguation as much).
  const m = text.match(/\b(199\d|200\d|201[0-5])\b/);
  return m ? parseInt(m[1], 10) : null;
}

async function ocrCopyrightYear(originalPath, tmpDir) {
  const ts = Date.now();

  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  if (!fs.existsSync(originalPath)) {
    return { text: "", year: null, error: "input_missing" };
  }

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const region = buildCopyrightRegion(W, H);
  const slot = await acquireWorker();

  // Try raw grayscale first, then threshold 130 for aged/yellowed stock.
  const passes = [
    { thr: null },
    { thr: 130 },
    { thr: 160 },
  ];

  try {
    for (const { thr } of passes) {
      const out = path.join(tmpDir, `copyright_${ts}_t${thr ?? "raw"}.png`);
      const useThreshold = thr !== null;

      try {
        let pipeline = sharp(originalPath)
          .extract({
            left:   Math.max(0, region.left),
            top:    Math.max(0, region.top),
            width:  Math.min(region.width,  W - region.left),
            height: Math.min(region.height, H - region.top),
          })
          .grayscale()
          .normalize()
          .sharpen()
          .resize({ width: 1800, withoutEnlargement: false });

        if (useThreshold) pipeline = pipeline.threshold(thr);
        await pipeline.toFile(out);

        const ocr = await recognizeWithTimeout(out, 15000, slot);
        const text = (ocr?.data?.text || "").replace(/\n/g, " ").trim();
        const year = parseCopyrightYear(text);

        if (year) {
          console.log(`✅ [copyrightYearOcr] Found year ${year} (thr=${thr ?? "raw"}): "${text}"`);
          return { text, year };
        }
      } catch (e) {
        // swallow, try next pass
      } finally {
        try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
      }
    }

    console.log(`⚠️ [copyrightYearOcr] No year found in: ${path.basename(originalPath)}`);
    return { text: "", year: null };
  } finally {
    releaseWorker(slot);
  }
}

module.exports = { ocrCopyrightYear, parseCopyrightYear };
