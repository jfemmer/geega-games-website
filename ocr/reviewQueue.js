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
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + "\n";
    fs.appendFileSync(queuePath, line, "utf8");
    return true;
  } catch {
    return false;
  }
}

module.exports = { enqueueForReview };
