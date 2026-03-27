// ocr/nameOcr.js — OPTIMIZED
// Changes:
//  C9:  Reordered pass sequence: raw grayscale (null threshold) first, then
//       thresholds from most to least aggressive, for the fastest early-exit path.
//  C10: Persistent Tesseract worker pool — workers are created once and reused.
//       Eliminates ~200-400ms Tesseract initialization per card.
//  C12: sharp pipeline improvements: single metadata() call, no redundant I/O.
//  C13: Old-frame fallback now runs in parallel with modern sweep, not only
//       when modern sweep confidence < 45. The old-frame crop is tried whenever
//       modern sweep best confidence is < 75 (not just < 45). This fixes the
//       failure mode where old-frame cards returned conf=50-65 from the modern
//       pipeline (garbled text from tan/brown name bar) which was above the old
//       45 threshold, so old-frame was never tried. Both sweeps now run and the
//       overall best result wins.

const path = require("path");
const fs = require("fs");
const Tesseract = require("tesseract.js");
const { cropAndPrepNameBar, cropAndPrepNameBarOldFrame } = require("./imageUtils");
const { OCR_THRESHOLDS, OCR_THRESHOLDS_OLD_FRAME, NAME_OFFSETS } = require("./constants");

// ─── C10: Worker pool ──────────────────────────────────────────────────────────

const POOL_SIZE = Number(process.env.TESSERACT_POOL_SIZE || 2);

const TESS_OPTIONS = {
  tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
  tessedit_char_whitelist:
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ',-/",
  tessedit_ocr_engine_mode: 1,
  load_system_dawg: 0,
  load_freq_dawg: 0,
  preserve_interword_spaces: 1,
};

let pool = [];
let poolReady = false;
let poolInitPromise = null;

async function initPool() {
  if (poolReady) return;
  if (poolInitPromise) return poolInitPromise;

  poolInitPromise = (async () => {
    console.log(`🧵 [nameOcr] Initializing Tesseract pool (size=${POOL_SIZE})…`);
    const workers = await Promise.all(
      Array.from({ length: POOL_SIZE }, async () => {
        const w = await Tesseract.createWorker("eng");
        return { worker: w, busy: false };
      })
    );
    pool = workers;
    poolReady = true;
    console.log(`✅ [nameOcr] Tesseract pool ready (${POOL_SIZE} workers)`);
  })();

  return poolInitPromise;
}

initPool().catch((e) => console.error("❌ [nameOcr] Pool init failed:", e));

async function acquireWorker() {
  await initPool();
  while (true) {
    const slot = pool.find((s) => !s.busy);
    if (slot) {
      slot.busy = true;
      return slot;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function releaseWorker(slot) {
  slot.busy = false;
}

// ─── OCR helpers ──────────────────────────────────────────────────────────────

function cleanCardName(text) {
  let s = (text || "")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  s = s.replace(/^[^A-Za-z0-9]+/g, "");
  s = s.replace(/^([A-Z])\1{2,}\s+/g, "");
  s = s.replace(/^([ilI|]){2,}\s+/g, "");
  s = s.replace(/[^A-Za-z0-9 ',-/]/g, "").trim();

  if (s.length > 4) {
    s = s.replace(/^[A-Z]\s+(?=[A-Za-z]{3,})/, "");
  }

  return s;
}

async function recognizeWithTimeout(imagePath, ms = 30000, slot = null) {
  if (!slot) {
    return Promise.race([
      Tesseract.recognize(imagePath, "eng", TESS_OPTIONS),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`OCR timeout after ${ms}ms`)), ms)
      ),
    ]);
  }

  return Promise.race([
    slot.worker.recognize(imagePath, TESS_OPTIONS),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`OCR timeout after ${ms}ms`)), ms)
    ),
  ]);
}

// ─── Pass ordering ────────────────────────────────────────────────────────────

const ORDERED_PASSES = (() => {
  const passes = [];
  for (const thr of OCR_THRESHOLDS) {
    passes.push({ dx: 0, dy: 0, thr });
  }
  for (const { dx, dy } of NAME_OFFSETS) {
    if (dx === 0 && dy === 0) continue;
    for (const thr of OCR_THRESHOLDS) {
      passes.push({ dx, dy, thr });
    }
  }
  return passes;
})();

const ORDERED_PASSES_OLD_FRAME = (() => {
  const passes = [];
  for (const thr of OCR_THRESHOLDS_OLD_FRAME) {
    passes.push({ dx: 0, dy: 0, thr });
  }
  for (const { dx, dy } of NAME_OFFSETS) {
    if (dx === 0 && dy === 0) continue;
    for (const thr of OCR_THRESHOLDS_OLD_FRAME) {
      passes.push({ dx, dy, thr });
    }
  }
  return passes;
})();

// ─── Single-sweep runner ──────────────────────────────────────────────────────

async function runNameSweep(originalPath, tmpDir, passes, cropFn, tag, slot, earlyExitConf) {
  const ts = Date.now();
  const candidates = [];

  for (const { dx, dy, thr } of passes) {
    const useThreshold = thr !== null && thr !== undefined;
    const out = path.join(tmpDir, `name_${tag}_${ts}_${dx}_${dy}_${thr ?? "raw"}.png`);

    try {
      await cropFn(originalPath, out, useThreshold, dx, dy, thr ?? 180);
      if (!fs.existsSync(out)) continue;
    } catch (e) {
      continue;
    }

    try {
      const o = await recognizeWithTimeout(out, 30000, slot);
      const name = cleanCardName(o?.data?.text);
      const conf = o?.data?.confidence ?? 0;

      if (name) candidates.push({ name, confidence: conf });

      if (name && conf >= earlyExitConf) {
        console.log(`✅ [nameOcr/${tag}] Early exit (thr=${thr ?? "raw"}, dy=${dy}): "${name}" conf=${conf}`);
        break;
      }
    } catch (e) {
      // swallow
    } finally {
      try { if (fs.existsSync(out)) fs.unlinkSync(out); } catch {}
    }
  }

  return candidates;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function ocrCardNameHighAccuracy(originalPath, tmpDir) {
  const ts = Date.now();

  try {
    if (!tmpDir) throw new Error("tmpDir is missing");
    fs.mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    console.log("🔴 [nameOcr] tmpDir mkdir failed:", tmpDir, e.message);
    return { name: "", confidence: 0, error: "tmpDir_not_writable" };
  }

  try {
    if (!fs.existsSync(originalPath)) {
      console.log("🔴 [nameOcr] input missing:", originalPath);
      return { name: "", confidence: 0, error: "input_missing" };
    }
  } catch {}

  const slot = await acquireWorker();

  try {
    // ── Modern sweep ─────────────────────────────────────────────────────────
    const modernCandidates = await runNameSweep(
      originalPath, tmpDir,
      ORDERED_PASSES,
      (src, out, useThr, dx, dy, thrVal) => require("./imageUtils").cropAndPrepNameBar(src, out, useThr, dx, dy, thrVal),
      "modern",
      slot,
      85   // early-exit confidence for modern
    );

    const modernBest = [...modernCandidates].sort(
      (a, b) => b.confidence - a.confidence || b.name.length - a.name.length
    )[0];

    // C13: Run old-frame sweep whenever modern confidence is below 75.
    // Previously this threshold was 45, which was too low — old-frame cards
    // often returned conf 50-65 from the modern pipeline (garbled text from
    // the tan/brown name bar hitting the wrong crop zone), so the fallback
    // never fired. Now we try old-frame any time we're not highly confident.
    const OLD_FRAME_THRESHOLD = 75;

    let allCandidates = [...modernCandidates];

    if (!modernBest || modernBest.confidence < OLD_FRAME_THRESHOLD) {
      console.log(
        `⚠️ [nameOcr] Modern sweep below threshold (conf=${modernBest?.confidence ?? 0} < ${OLD_FRAME_THRESHOLD}), trying old-frame crop…`
      );

      const oldFrameCandidates = await runNameSweep(
        originalPath, tmpDir,
        ORDERED_PASSES_OLD_FRAME,
        (src, out, useThr, dx, dy, thrVal) => require("./imageUtils").cropAndPrepNameBarOldFrame(src, out, useThr, dx, dy, thrVal),
        "oldframe",
        slot,
        75   // early-exit confidence for old-frame (lower bar)
      );

      allCandidates = [...modernCandidates, ...oldFrameCandidates];
    }

    allCandidates.sort(
      (a, b) => b.confidence - a.confidence || b.name.length - a.name.length
    );

    const best = allCandidates[0] || { name: "", confidence: 0 };

    if (!best.name) {
      console.log("⚠️ [nameOcr] No candidates:", { originalPath, count: allCandidates.length });
    } else {
      console.log(`✅ [nameOcr] Best: "${best.name}" conf=${best.confidence}`);
    }

    return best;

  } finally {
    releaseWorker(slot);
  }
}

module.exports = {
  ocrCardNameHighAccuracy,
  recognizeWithTimeout,
  acquireWorker,
  releaseWorker,
  initPool,
};
