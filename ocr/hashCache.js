// ocr/hashCache.js
const fs = require("fs");
const path = require("path");

const CACHE_PATH = process.env.RAILWAY_ENVIRONMENT
  ? "/tmp/scryfall_art_hash_cache.json"
  : path.join(__dirname, "..", "scryfall_art_hash_cache.json");

let cache = {};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) || {};
    }
  } catch {
    cache = {};
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
  } catch {}
}

function getHash(key) {
  return cache[key] || null;
}

function setHash(key, hash) {
  cache[key] = hash;
  saveCache();
}

loadCache();

module.exports = { getHash, setHash };
