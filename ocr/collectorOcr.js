// ocr/collectorOcr.js
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const Tesseract = require("tesseract.js");

const { recognizeWithTimeout } = require("./nameOcr");
const { cropAndPrepCollectorRegion, buildCollectorRegions } = require("./imageUtils");
const { OCR_THRESHOLDS, COLLECTOR_OFFSETS } = require("./constants");

function cleanBottomText(text) {
  return (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCollectorNumberStrict(bottomText) {
  const s = (bottomText || "")
    .replace(/\s+/g, " ")
    .replace(/[|]/g, "/")
    .replace(/[^0-9/ ]/g, "")
    .trim();

  // Prefer "123/350" format
  const m1 = s.match(/(\d{1,4})\s*\/\s*(\d{1,4})/);
  if (m1) {
    const n = parseInt(m1[1], 10);
    return Number.isFinite(n) ? { value: String(n), mode: "slash" } : null;
  }

  // Fallback: standalone number
  const m2 = s.match(/\b(\d{1,4})\b/);
  if (m2) {
    const n = parseInt(m2[1], 10);
    return Number.isFinite(n) ? { value: String(n), mode: "standalone" } : null;
  }

  return null;
}

/**
 * Parses the set code from the bottom text line.
 * Modern cards have: "046/291" on one line, then "MH3 EN <artist>" below.
 * Older cards may have the set code embedded differently.
 *
 * Returns the set code string (e.g. "MH3") or null.
 */
function parseSetCode(rawText) {
  if (!rawText) return null;

  const lines = rawText
    .split(/\n/)
    .map(l => l.trim())
    .filter(Boolean);

  for (const line of lines) {
    // Set codes are 2-5 uppercase letters, sometimes with digits (e.g. M21, MH3, NEO, DMU)
    // They appear at the start of the line before the language code
    // Match: "MH3 EN" or "M21" or "NEO" etc.
    const m = line.match(/^([A-Z0-9]{2,5})\b/);
    if (m) {
      const candidate = m[1];

      // Reject things that look like language codes or noise
      const SKIP = new Set(["EN", "FR", "DE", "IT", "ES", "PT", "JA", "KO", "RU", "ZHS", "ZHT"]);
      if (SKIP.has(candidate)) continue;

      // Must contain at least one letter (not pure number)
      if (/^[0-9]+$/.test(candidate)) continue;

      return candidate.toLowerCase(); // return lowercase to match Scryfall set codes
    }
  }

  return null;
}

/**
 * Builds a taller crop region that captures BOTH lines:
 *   Line 1: collector number  (e.g. "046/291")
 *   Line 2: set code + lang   (e.g. "MH3 EN")
 *
 * We use a separate wider region specifically for this two-line read.
 */
function buildBottomTwoLineRegions(W, H) {
  return [
    // Primary: left side where collector + set code live on modern cards
    {
      left:   Math.floor(W * 0.04),
      top:    Math.floor(H * 0.905),   // start a bit higher to catch both lines
      width:  Math.floor(W * 0.35),    // wide enough for "046/291\nMH3 EN"
      height: Math.floor(H * 0.060),   // tall enough for two text lines
    },
    // Fallback: slightly lower in case card sits lower in frame
    {
      left:   Math.floor(W * 0.04),
      top:    Math.floor(H * 0.915),
      width:  Math.floor(W * 0.35),
      height: Math.floor(H * 0.060),
    },
  ];
}

async function ocrCollectorNumberHighAccuracy(originalPath, tmpDir) {
  const ts = Date.now();

  try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}

  if (!fs.existsSync(originalPath)) {
    return { text: "", confidence: 0, collectorNumber: null, setCode: null, error: "input_missing" };
  }

  const meta = await sharp(originalPath).metadata();
  const W = meta.width;
  const H = meta.height;

  // Use the two-line regions first, fall back to original single-line regions
  const twoLineRegions = buildBottomTwoLineRegions(W, H);
  const singleLineRegions = buildCollectorRegions(W, H);

  // For the two-line pass, use PSM.AUTO_OSD or SINGLE_BLOCK to get both lines
  const optsMultiLine = {
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_BLOCK,
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/ ",
  };

  // For the collector-only pass, keep strict numeric whitelist
  const optsStrict = {
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    tessedit_char_whitelist: "0123456789/ ",
  };

  const candidates = [];

  // ── Pass 1: Two-line crop to get collector number AND set code together ──
  for (let i = 0; i < twoLineRegions.length; i++) {
    const region = twoLineRegions[i];

    for (let t = 0; t < OCR_THRESHOLDS.length; t++) {
      const thr = OCR_THRESHOLDS[t];
      const useThreshold = thr !== null && thr !== undefined;
      const out = path.join(tmpDir, `bottom2_${ts}_r${i}_t${t}.png`);

      try {
        await cropAndPrepCollectorRegion(originalPath, out, region, useThreshold, 0, 0, thr ?? 180);
        const ocr = await recognizeWithTimeout(out, 90000, optsMultiLine);

        // Use raw text (with newlines) for set code parsing
        const rawText = ocr?.data?.text || "";
        const cleanText = cleanBottomText(rawText);
        const conf = ocr?.data?.confidence ?? 0;

        const parsed = parseCollectorNumberStrict(cleanText);
        const collectorNumber = parsed?.value ?? null;
        const parseMode = parsed?.mode ?? null;
        const setCode = parseSetCode(rawText);

        if (collectorNumber && collectorNumber.length > 4) continue;

        candidates.push({
          pass: "two-line",
          regionIndex: i,
          thrIndex: t,
          text: cleanText,
          rawText,
          conf,
          collectorNumber,
          parseMode,
          setCode,
        });

        console.log("🔢 [collectorOcr] two-line candidate:", {
          collectorNumber,
          setCode,
          conf: Math.round(conf),
          text: cleanText.slice(0, 60)
        });

        // Early exit: got both collector + set code with good confidence
        const minConf = parseMode === "standalone" ? 85 : 55;
        if (collectorNumber && setCode && conf >= minConf) {
          console.log("✅ [collectorOcr] early exit with collector + setCode:", { collectorNumber, setCode });
          return { text: cleanText, confidence: conf, collectorNumber, setCode };
        }

        // Early exit: got collector number alone with high confidence
        if (collectorNumber && conf >= minConf && !setCode) {
          // Don't return yet — keep trying to find set code in other passes
          // but note this as a strong candidate
        }

      } catch (e) {
        candidates.push({
          pass: "two-line",
          regionIndex: i,
          thrIndex: t,
          text: "", conf: 0,
          collectorNumber: null, parseMode: null, setCode: null,
          err: e?.message || String(e),
        });
      } finally {
        try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
      }
    }
  }

  // ── Pass 2: Original single-line regions for collector number only ──
  for (let i = 0; i < singleLineRegions.length; i++) {
    const region = singleLineRegions[i];

    for (let o = 0; o < COLLECTOR_OFFSETS.length; o++) {
      const { dx, dy } = COLLECTOR_OFFSETS[o];

      for (let t = 0; t < OCR_THRESHOLDS.length; t++) {
        const thr = OCR_THRESHOLDS[t];
        const useThreshold = thr !== null && thr !== undefined;
        const out = path.join(tmpDir, `bottom_${ts}_r${i}_o${o}_t${t}.png`);

        try {
          await cropAndPrepCollectorRegion(originalPath, out, region, useThreshold, dx, dy, thr ?? 180);
          const ocr = await recognizeWithTimeout(out, 90000, optsStrict);
          const text = cleanBottomText(ocr?.data?.text);
          const conf = ocr?.data?.confidence ?? 0;
          const parsed = parseCollectorNumberStrict(text);

          const collectorNumber = parsed?.value ?? null;
          if (collectorNumber && collectorNumber.length > 4) continue;
          const parseMode = parsed?.mode ?? null;

          candidates.push({
            pass: "single-line",
            regionIndex: i,
            offsetIndex: o,
            thrIndex: t,
            text,
            conf,
            collectorNumber,
            parseMode,
            setCode: null, // single-line pass can't get set code
          });

          const minConf = parseMode === "standalone" ? 85 : 55;
          if (collectorNumber && conf >= minConf) {
            // Check if any two-line candidate already found a set code
            const setCodeFromTwoLine = candidates.find(c => c.setCode)?.setCode || null;
            return { text, confidence: conf, collectorNumber, setCode: setCodeFromTwoLine };
          }
        } catch (e) {
          candidates.push({
            pass: "single-line",
            regionIndex: i,
            offsetIndex: o,
            thrIndex: t,
            text: "", conf: 0,
            collectorNumber: null, parseMode: null, setCode: null,
            err: e?.message || String(e),
          });
        } finally {
          try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
        }
      }
    }
  }

  // ── Pick best overall candidate ──
  candidates.sort(
    (a, b) =>
      (b.collectorNumber ? 1 : 0) - (a.collectorNumber ? 1 : 0) ||
      (b.setCode ? 1 : 0) - (a.setCode ? 1 : 0) ||
      ((b.parseMode === "slash") ? 2 : 0) - ((a.parseMode === "slash") ? 2 : 0) ||
      (b.conf - a.conf)
  );

  const best = candidates[0] || { text: "", conf: 0, collectorNumber: null, setCode: null };

  if (!best.collectorNumber) {
    console.log("⚠️ No valid collector number found for:", originalPath);
  }
  if (!best.setCode) {
    console.log("⚠️ No set code found for:", originalPath);
  }

  return {
    text: best.text || "",
    confidence: best.conf || 0,
    collectorNumber: best.collectorNumber || null,
    setCode: best.setCode || null,
  };
}

module.exports = {
  ocrCollectorNumberHighAccuracy,
};
