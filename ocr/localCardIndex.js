const fs = require("fs");
const path = require("path");

const LOCAL_INDEX_PATH =
  process.env.LOCAL_INDEX_PATH || "D:/MTG_DATA/scryfall/local_index.json";

let CACHE = null;

function loadLocalIndex() {
  if (CACHE) return CACHE;
  try {
    CACHE = JSON.parse(fs.readFileSync(LOCAL_INDEX_PATH, "utf8"));
    return CACHE;
  } catch (e) {
    console.warn("⚠️ local_index.json not found, local matching disabled.");
    return [];
  }
}

function normalizeName(str = "") {
  return String(str).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getAllCards() {
  return loadLocalIndex();
}

function findBestNameMatches(name, limit = 25) {
  const cards = loadLocalIndex();
  const target = normalizeName(name);

  if (!target) return [];

  const exact = [];
  const starts = [];
  const contains = [];

  for (const card of cards) {
    const n = card.normalized_name || normalizeName(card.name || "");
    if (n === target) exact.push(card);
    else if (n.startsWith(target)) starts.push(card);
    else if (n.includes(target)) contains.push(card);
  }

  return [...exact, ...starts, ...contains].slice(0, limit);
}

function findExactPrinting(setCode, collectorNumber) {
  const cards = loadLocalIndex();
  const set = String(setCode || "").trim().toLowerCase();
  const collector = String(collectorNumber || "").trim().replace(/^0+/, "");

  return cards.find(card => {
    const cardSet = String(card.set || "").trim().toLowerCase();
    const cardCollector = String(card.collector_number || "").trim().replace(/^0+/, "");
    return cardSet === set && cardCollector === collector;
  }) || null;
}

module.exports = {
  getAllCards,
  findBestNameMatches,
  findExactPrinting,
  normalizeName
};
