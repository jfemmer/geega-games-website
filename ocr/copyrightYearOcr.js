// ocr/copyrightYearOcr.js
// Extracts the copyright year from the bottom-right info line of a scanned card.
//
// Old MTG cards (pre-~2003) print a copyright year here, e.g. "© 1994"
// or "TM & © 1993 Wizards of the Coast". This year is the single most
// reliable signal for narrowing down which printing an old card belongs to.
//
// On OLD-FRAME cards (pre-8th Edition): there is NO collector number.
// The copyright line is the only text in the bottom strip, positioned at
// roughly H*0.925-0.955, right half of the card.
//
// On MODERN-FRAME cards (8th Edition onward): collector number is on the left,
// copyright sits on the right of the same strip or is absent post-2015.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");
const { acquireWorker, releaseWorker } = require("./nameOcr");
const { DEBUG_OCR, DEBUG_DIR } = require("./constants");

// ─── Tesseract options ────────────────────────────────────────────────────────
//
// ROOT CAUSE FIX: recognizeWithTimeout() always injects TESS_OPTIONS from
// nameOcr.js, whose character whitelist excludes © and &. Those are the
// anchor characters for "© 1994" and "TM & © 1993". We MUST call
// slot.worker.recognize() directly with these options, never go through
// recognizeWithTimeout.

const COPYRIGHT_OPTS = {
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  tessedit_char_whitelist:
    "©TMtm&0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz .",
};

// ─── Region builder ────────────────────────────────────────────────────────────
//
// Three regions, tried in order:
//   [0] Old-frame primary: the copyright line on pre-8th cards sits at H*0.928-0.958.
//       No collector number exists so the full right half is available.
//   [1] Overlap band: covers both old-frame and modern-frame positions (wider net).
//   [2] Wide fallback: full-width bottom strip for unusual layouts.

function buildCopyrightRegions(W, H) {
  return [
    {
      // Old-frame primary — copyright is the only line in this area
      left:   Math.floor(W * 0.38),   // start slightly left of center to catch "TM &" prefix
      top:    Math.floor(H * 0.925),
      width:  Math.floor(W * 0.56),
      height: Math.floor(H * 0.038),  // tight: just the one text line at 300dpi
    },
    {
      // Modern-frame / overlap: same right-half but taller to catch any shift
      left:   Math.floor(W * 0.45),
      top:    Math.floor(H * 0.910),
      width:  Math.floor(W * 0.50),
      height: Math.floor(H * 0.055),
    },
    {
      // Wide fallback: entire bottom strip, useful when layout is uncertain
      left:   Math.floor(W * 0.20),
      top:    Math.floor(H * 0.915),
      width:  Math.floor(W * 0.75),
      height: Math.floor(H * 0.065),
    },
  ];
}

// ─── Year parser ───────────────────────────────────────────────────────────────

function parseCopyrightYear(text) {
  if (!text) return null;
  // Match 4-digit years 1990-2015. Alpha/Beta/Unlimited are 1993;
  // nothing earlier was commercially released.
  const m = text.match(/\b(199\d|200\d|201[0-5])\b/);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Debug save ────────────────────────────────────────────────────────────────

function saveDebugCrop(buf, ts, tag) {
  if (!DEBUG_OCR || !buf) return null;
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const filename = `copyright_${ts}_${tag}.png`;
    const outPath = path.join(DEBUG_DIR, filename);
    fs.writeFileSync(outPath, buf);
    console.log("🟠 [copyrightYearOcr] Debug crop:", outPath);
    return outPath;
  } catch {
    return null;
  }
}

// ─── Main export ───────────────────────────────────────────────────────────────

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

  // Threshold ordering: raw grayscale first (fast exit for clean scans),
  // then low thresholds for aged/yellowed stock, then mid-range.
  const thresholds = [null, 130, 110, 160];

  try {
    for (let ri = 0; ri < regions.length; ri++) {
      const region = regions[ri];

      const clampedRegion = {
        left:   Math.max(0, Math.min(W - 2, region.left)),
        top:    Math.max(0, Math.min(H - 2, region.top)),
        width:  Math.max(1, Math.min(region.width,  W - region.left)),
        height: Math.max(1, Math.min(region.height, H - region.top)),
      };

      for (const thr of thresholds) {
        const tag = `r${ri}_t${thr ?? "raw"}`;
        const out = path.join(tmpDir, `copyright_${ts}_${tag}.png`);
        const useThreshold = thr !== null;

        try {
          let pipeline = sharp(originalPath)
            .extract(clampedRegion)
            .grayscale()
            .normalize()
            .sharpen()
            .resize({ width: 1800, withoutEnlargement: false });

          if (useThreshold) pipeline = pipeline.threshold(thr);
          await pipeline.toFile(out);

          // Save debug crop BEFORE OCR so it persists even if OCR fails.
          if (DEBUG_OCR && fs.existsSync(out)) {
            saveDebugCrop(fs.readFileSync(out), ts, tag);
          }

          // CRITICAL: call slot.worker.recognize with COPYRIGHT_OPTS directly.
          // Do NOT use recognizeWithTimeout() -- it forces TESS_OPTIONS which
          // strips copyright symbols from the whitelist, breaking the year regex.
          const ocr = await Promise.race([
            slot.worker.recognize(out, COPYRIGHT_OPTS),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error("copyright OCR timeout")), 15000)
            ),
          ]);

          const text = (ocr?.data?.text || "").replace(/\n/g, " ").trim();
          const year = parseCopyrightYear(text);

          if (year) {
            console.log(`✅ [copyrightYearOcr] Year ${year} (region=${ri}, thr=${thr ?? "raw"}): "${text}"`);
            return { text, year };
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
