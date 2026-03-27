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
const { acquireWorker, releaseWorker } = require("./nameOcr");
const { DEBUG_OCR, DEBUG_DIR } = require("./constants");

// ─── Region builder ───────────────────────────────────────────────────────────
//
// FIX (Bug 2): Old-frame cards have no collector number so the copyright line
// sits lower than on modern cards — approximately H*0.930 rather than H*0.915.
// We now try two vertical bands: the lower band first (old-frame primary),
// then a higher band as a fallback for modern-frame cards that do have a
// copyright line (pre-2015).
//
// The region intentionally stays in the right half of the card (left=0.50)
// so it never overlaps the collector number on the left side.

function buildCopyrightRegions(W, H) {
  return [
    // Primary: old-frame position — copyright line near the card edge, no collector above it.
    {
      left:   Math.floor(W * 0.50),
      top:    Math.floor(H * 0.930),  // was 0.915 — now targets actual old-frame line
      width:  Math.floor(W * 0.44),
      height: Math.floor(H * 0.045), // slightly taller to catch registration drift
    },
    // Fallback: modern-frame position — useful for pre-2015 modern-frame cards
    // that still print a copyright year.
    {
      left:   Math.floor(W * 0.50),
      top:    Math.floor(H * 0.912),
      width:  Math.floor(W * 0.44),
      height: Math.floor(H * 0.038),
    },
    // Wide fallback: covers the full bottom strip in case of unusual layout.
    {
      left:   Math.floor(W * 0.30),
      top:    Math.floor(H * 0.925),
      width:  Math.floor(W * 0.64),
      height: Math.floor(H * 0.055),
    },
  ];
}

// ─── Tesseract options ────────────────────────────────────────────────────────
//
// FIX (Bug 1): recognizeWithTimeout previously always used TESS_OPTIONS from
// nameOcr.js, which strips © and & from the character whitelist. Those symbols
// anchor the copyright line ("© 1994", "TM & © 1993"). We now call
// slot.worker.recognize() directly with COPYRIGHT_OPTS so the whitelist is used.

const COPYRIGHT_OPTS = {
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  // Keep © alternatives, letters (so "Wizards" doesn't confuse the parser),
  // digits, and common punctuation on the copyright line.
  tessedit_char_whitelist:
    "©TMtm&0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .",
};

// ─── Year parser ──────────────────────────────────────────────────────────────
//
// FIX (Bug 4 partial): Extended lower bound to 1990. Alpha/Beta/Unlimited are
// 1993, Antiquities 1994, and nothing earlier than 1993 was commercially released,
// but 1990 gives a safe margin. Post-2015 cards rarely print a year.

function parseCopyrightYear(text) {
  if (!text) return null;
  const m = text.match(/\b(199\d|200\d|201[0-5])\b/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Debug save helper ────────────────────────────────────────────────────────
//
// FIX (Bug 5): Save crops to ocr_debug/ when DEBUG_OCR=true, same pattern as
// other OCR modules, so you can actually inspect what region is being cropped.

function _saveDebugCrop(buf, ts, tag) {
  if (!DEBUG_OCR || !buf) return null;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filename = `copyright_${ts}_${tag}.png`;
    const outPath = path.join(DEBUG_DIR, filename);
    fs.writeFileSync(outPath, buf);
    console.log("🟠 [copyrightYearOcr] Debug crop saved:", outPath);
    return outPath;
  } catch {
    return null;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function ocrCopyrightYear(originalPath, tmpDir) {
  const ts = Date.now();

  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  if (!fs.existsSync(originalPath)) {
    return { text: "", year: null, error: "input_missing" };
  }

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  const regions = buildCopyrightRegions(W, H);
  const slot = await acquireWorker();

  // Pass ordering: raw grayscale (null) first — works for clean/high-contrast scans.
  // Then lower thresholds for aged/yellowed stock where 180 washes out thin ink.
  const thresholds = [null, 130, 160, 110];

  try {
    for (let ri = 0; ri < regions.length; ri++) {
      const region = regions[ri];

      for (const thr of thresholds) {
        const tag = `r${ri}_t${thr ?? "raw"}`;
        const out = path.join(tmpDir, `copyright_${ts}_${tag}.png`);
        const useThreshold = thr !== null;

        try {
          const clampedRegion = {
            left:   Math.max(0, Math.min(W - 2, region.left)),
            top:    Math.max(0, Math.min(H - 2, region.top)),
            width:  Math.max(1, Math.min(region.width,  W - region.left)),
            height: Math.max(1, Math.min(region.height, H - region.top)),
          };

          let pipeline = sharp(originalPath)
            .extract(clampedRegion)
            .grayscale()
            .normalize()
            .sharpen()
            .resize({ width: 1800, withoutEnlargement: false });

          if (useThreshold) pipeline = pipeline.threshold(thr);
          await pipeline.toFile(out);

          // FIX (Bug 5): Save debug crop before OCR, so it persists even if OCR throws.
          if (DEBUG_OCR && fs.existsSync(out)) {
            _saveDebugCrop(fs.readFileSync(out), ts, tag);
          }

          // FIX (Bug 1): Call slot.worker.recognize directly with COPYRIGHT_OPTS,
          // bypassing recognizeWithTimeout which always injects TESS_OPTIONS.
          const ocr = await Promise.race([
            slot.worker.recognize(out, COPYRIGHT_OPTS),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("copyright OCR timeout")), 15000)
            ),
          ]);

          const text = (ocr?.data?.text || "").replace(/\n/g, " ").trim();
          const year = parseCopyrightYear(text);

          if (year) {
            console.log(`✅ [copyrightYearOcr] Found year ${year} (region=${ri}, thr=${thr ?? "raw"}): "${text}"`);
            return { text, year, debugTag: tag };
          } else {
            console.log(`⬜ [copyrightYearOcr] No year (region=${ri}, thr=${thr ?? "raw"}): "${text}"`);
          }
        } catch (e) {
          console.log(`⚠️ [copyrightYearOcr] Pass failed (region=${ri}, thr=${thr ?? "raw"}):`, e.message);
        } finally {
          try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
        }
      }
    }

    console.log(`⚠️ [copyrightYearOcr] No year found in: ${path.basename(originalPath)}`);
    return { text: "", year: null };
  } finally {
    releaseWorker(slot);
  }
}

module.exports = { ocrCopyrightYear, parseCopyrightYear };
