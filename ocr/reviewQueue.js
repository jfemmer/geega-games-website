// ocr/reviewQueue.js
const fs = require("fs");
const path = require("path");
const { DEFAULT_REVIEW_QUEUE_PATH } = require("./constants");

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/**
 * Append a JSONL record to a local file for manual review.
 * Safe to call in production — it will never throw; it will just no-op if it can't write.
 */
function enqueueForReview(record, queuePath = DEFAULT_REVIEW_QUEUE_PATH) {
  try {
    const dir = path.dirname(queuePath);
    ensureDir(dir);

    const incomingHash = String(record?.reviewHash || "").trim();

    if (incomingHash && fs.existsSync(queuePath)) {
      const raw = fs.readFileSync(queuePath, "utf8");
      const lines = raw.split("\n").map(x => x.trim()).filter(Boolean);

      for (const line of lines) {
        try {
          const item = JSON.parse(line);
          if (String(item?.reviewHash || "").trim() === incomingHash) {
            console.log("⛔ [reviewQueue] Duplicate hash, skipping:", incomingHash, "| file:", record?.file);
            return false; // duplicate review item
          }
        } catch {}
      }
    }

    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    fs.appendFileSync(queuePath, line, "utf8");
    console.log("✅ [reviewQueue] Written:", record?.file, "| reason:", record?.reason, "| path:", queuePath);
    return true;
  } catch (err) {
    console.error("❌ [reviewQueue] enqueueForReview failed:", err.message, "| path:", queuePath, "| file:", record?.file);
    return false;
  }
}

module.exports = { enqueueForReview };
