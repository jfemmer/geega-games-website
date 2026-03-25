// cropDebugViewer.js
// Mount this in server.js with:
//   const { registerCropDebugRoutes } = require("./cropDebugViewer");
//   registerCropDebugRoutes(app);
//
// Then serve the debug dir statically (already done in server.js via OCR_DEBUG_DIR):
//   app.use("/ocr_debug", express.static(OCR_DEBUG_DIR));
//
// Access at: http://localhost:<PORT>/debug/crops

const fs   = require("fs");
const path = require("path");

const DEBUG_DIR = path.join(__dirname, "ocr_debug");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function listDebugFiles() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) return [];
    return fs.readdirSync(DEBUG_DIR)
      .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
      .sort((a, b) => {
        // Sort newest first by mtime
        const ma = fs.statSync(path.join(DEBUG_DIR, a)).mtimeMs;
        const mb = fs.statSync(path.join(DEBUG_DIR, b)).mtimeMs;
        return mb - ma;
      });
  } catch { return []; }
}

function classifyFile(filename) {
  const f = filename.toLowerCase();
  if (f.startsWith("preview_name"))        return { type: "name",      label: "Name Bar",       color: "#a78bfa" };
  if (f.startsWith("name_"))               return { type: "name",      label: "Name Bar",       color: "#a78bfa" };
  if (f.startsWith("preview_artwork"))     return { type: "artwork",   label: "Artwork",         color: "#34d399" };
  if (f.startsWith("preview_collector"))   return { type: "collector", label: "Collector #",     color: "#fb923c" };
  if (f.startsWith("bottom_"))             return { type: "collector", label: "Collector #",     color: "#fb923c" };
  if (f.startsWith("preview_setsymbol"))   return { type: "symbol",    label: "Set Symbol",      color: "#f472b6" };
  if (f.startsWith("symbol_"))             return { type: "symbol",    label: "Set Symbol",      color: "#f472b6" };
  if (f.startsWith("setcode_"))            return { type: "setcode",   label: "Set Code",        color: "#4ade80" };
  if (f.startsWith("preview_frame"))       return { type: "frame",     label: "Frame Hash",      color: "#60a5fa" };
  if (f.startsWith("preview_full"))        return { type: "full",      label: "Full Card Hash",  color: "#94a3b8" };
  return                                          { type: "other",     label: "Other",           color: "#64748b" };
}

// Group files by their timestamp prefix (e.g. "1716000000000" from "name_1716000000000_0_0_raw.png")
function groupFilesBySession(files) {
  const sessions = new Map();

  for (const f of files) {
    // Extract leading timestamp from filename if present
    const tsMatch = f.match(/[_\-]?(\d{13})[_\-]/);
    const key     = tsMatch ? tsMatch[1] : "ungrouped";

    if (!sessions.has(key)) sessions.set(key, { ts: key, files: [] });
    sessions.get(key).files.push(f);
  }

  // Sort sessions newest first
  return [...sessions.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([ts, data]) => data);
}

// ─── HTML template ────────────────────────────────────────────────────────────

function buildPage(files) {
  const sessions = groupFilesBySession(files);
  const totalFiles = files.length;

  const TYPE_ORDER = ["name", "collector", "setcode", "symbol", "artwork", "frame", "full", "other"];

  const sessionBlocks = sessions.map((session, si) => {
    const ts = session.ts !== "ungrouped"
      ? new Date(Number(session.ts)).toLocaleString()
      : "Ungrouped";

    // Sort files within session by type order, then alphabetically
    const sorted = [...session.files].sort((a, b) => {
      const ai = TYPE_ORDER.indexOf(classifyFile(a).type);
      const bi = TYPE_ORDER.indexOf(classifyFile(b).type);
      return (ai - bi) || a.localeCompare(b);
    });

    const cards = sorted.map(f => {
      const { label, color } = classifyFile(f);
      const stat = (() => {
        try { return fs.statSync(path.join(DEBUG_DIR, f)); } catch { return null; }
      })();
      const size = stat ? (stat.size / 1024).toFixed(1) + " KB" : "";

      return `
        <div class="crop-card" data-type="${classifyFile(f).type}">
          <div class="crop-label" style="--badge-color:${color}">${label}</div>
          <a href="/ocr_debug/${encodeURIComponent(f)}" target="_blank" class="img-link">
            <img
              src="/ocr_debug/${encodeURIComponent(f)}"
              loading="lazy"
              alt="${f}"
              onerror="this.parentElement.parentElement.classList.add('img-error')"
            />
            <div class="img-overlay">Open full size ↗</div>
          </a>
          <div class="crop-filename">${f}</div>
          <div class="crop-meta">${size}</div>
        </div>`;
    }).join("");

    return `
      <section class="session" ${si === 0 ? 'data-latest="true"' : ""}>
        <div class="session-header">
          <span class="session-time">${ts}</span>
          <span class="session-count">${session.files.length} crops</span>
          ${si === 0 ? '<span class="session-badge">Latest</span>' : ""}
        </div>
        <div class="crop-grid">${cards}</div>
      </section>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crop Debug Viewer</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Syne:wght@400;700;800&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg:        #0a0b0f;
    --surface:   #12141a;
    --surface2:  #1a1d26;
    --border:    #252836;
    --text:      #e2e5f0;
    --muted:     #6b7280;
    --accent:    #6366f1;
    --accent2:   #818cf8;
    --green:     #34d399;
    --orange:    #fb923c;
    --pink:      #f472b6;
    --blue:      #60a5fa;
    --purple:    #a78bfa;
  }

  html { scroll-behavior: smooth; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Syne', sans-serif;
    min-height: 100vh;
  }

  /* ── Header ── */
  header {
    position: sticky;
    top: 0;
    z-index: 100;
    background: rgba(10, 11, 15, 0.92);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border);
    padding: 0 2rem;
    display: flex;
    align-items: center;
    gap: 2rem;
    height: 60px;
  }

  .logo {
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 0.5rem;
    white-space: nowrap;
  }

  .logo-dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 8px var(--accent);
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(0.8); }
  }

  .header-stats {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    color: var(--muted);
  }

  .header-right {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  /* ── Filters ── */
  .filter-bar {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .filter-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    font-weight: 600;
    padding: 0.3rem 0.75rem;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
    cursor: pointer;
    transition: all 0.15s ease;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }

  .filter-btn:hover,
  .filter-btn.active {
    border-color: var(--accent);
    color: var(--accent2);
    background: rgba(99, 102, 241, 0.1);
  }

  /* ── Refresh ── */
  .refresh-btn {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.75rem;
    padding: 0.4rem 1rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface2);
    color: var(--text);
    cursor: pointer;
    transition: all 0.15s ease;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .refresh-btn:hover {
    border-color: var(--accent);
    color: var(--accent2);
  }

  .refresh-btn.spinning .icon { animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Main layout ── */
  main {
    max-width: 1600px;
    margin: 0 auto;
    padding: 2rem;
  }

  /* ── Empty state ── */
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 6rem 2rem;
    gap: 1rem;
    color: var(--muted);
    text-align: center;
  }

  .empty-icon { font-size: 3rem; opacity: 0.3; }
  .empty-title { font-size: 1.25rem; font-weight: 700; color: var(--text); }
  .empty-sub { font-family: 'JetBrains Mono', monospace; font-size: 0.8rem; }

  /* ── Session ── */
  .session {
    margin-bottom: 3rem;
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  .session-header {
    display: flex;
    align-items: center;
    gap: 1rem;
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--border);
  }

  .session-time {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.8rem;
    color: var(--muted);
  }

  .session-count {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.7rem;
    background: var(--surface2);
    border: 1px solid var(--border);
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    color: var(--muted);
  }

  .session-badge {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    background: rgba(99,102,241,0.15);
    border: 1px solid rgba(99,102,241,0.4);
    color: var(--accent2);
    padding: 0.15rem 0.6rem;
    border-radius: 4px;
  }

  /* ── Crop Grid ── */
  .crop-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 1rem;
  }

  /* ── Crop Card ── */
  .crop-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.15s, transform 0.15s, box-shadow 0.15s;
    display: flex;
    flex-direction: column;
  }

  .crop-card:hover {
    border-color: rgba(99,102,241,0.4);
    transform: translateY(-2px);
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  }

  .crop-card.img-error {
    opacity: 0.5;
    border-color: #ef4444;
  }

  .crop-card.hidden { display: none; }

  .crop-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.4rem 0.75rem;
    color: var(--bg);
    background: var(--badge-color, var(--accent));
  }

  .img-link {
    display: block;
    position: relative;
    background: #000;
    overflow: hidden;
    flex: 1;
  }

  .img-link img {
    width: 100%;
    height: 140px;
    object-fit: contain;
    display: block;
    transition: transform 0.2s ease;
  }

  .img-link:hover img { transform: scale(1.04); }

  .img-overlay {
    position: absolute;
    inset: 0;
    background: rgba(99,102,241,0.85);
    color: #fff;
    font-size: 0.75rem;
    font-weight: 700;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .img-link:hover .img-overlay { opacity: 1; }

  .crop-filename {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem;
    color: var(--muted);
    padding: 0.5rem 0.75rem 0.2rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .crop-meta {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.6rem;
    color: #374151;
    padding: 0 0.75rem 0.5rem;
  }

  /* ── Auto-refresh indicator ── */
  .auto-indicator {
    font-family: 'JetBrains Mono', monospace;
    font-size: 0.65rem;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }

  .auto-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: var(--green);
    animation: pulse 2s ease-in-out infinite;
  }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-dot"></div>
    Crop Debug Viewer
  </div>
  <div class="header-stats">${totalFiles} files &nbsp;·&nbsp; ${sessions.length} sessions</div>

  <div class="filter-bar" id="filterBar">
    <button class="filter-btn active" onclick="setFilter('all', this)">All</button>
    <button class="filter-btn" onclick="setFilter('name', this)"     style="--c:#a78bfa">Name</button>
    <button class="filter-btn" onclick="setFilter('collector', this)" style="--c:#fb923c">Collector</button>
    <button class="filter-btn" onclick="setFilter('setcode', this)"   style="--c:#4ade80">Set Code</button>
    <button class="filter-btn" onclick="setFilter('symbol', this)"    style="--c:#f472b6">Symbol</button>
    <button class="filter-btn" onclick="setFilter('artwork', this)"   style="--c:#34d399">Artwork</button>
    <button class="filter-btn" onclick="setFilter('frame', this)"     style="--c:#60a5fa">Frame</button>
    <button class="filter-btn" onclick="setFilter('full', this)"      style="--c:#94a3b8">Full</button>
  </div>

  <div class="header-right">
    <div class="auto-indicator">
      <div class="auto-dot"></div>
      auto-refresh 10s
    </div>
    <button class="refresh-btn" id="refreshBtn" onclick="manualRefresh()">
      <span class="icon">↻</span> Refresh
    </button>
  </div>
</header>

<main>
  ${sessions.length === 0
    ? `<div class="empty">
         <div class="empty-icon">🔍</div>
         <div class="empty-title">No debug crops yet</div>
         <div class="empty-sub">Scan a card with DEBUG_OCR=true to see crops here.<br>They'll appear in: ocr_debug/</div>
       </div>`
    : sessionBlocks
  }
</main>

<script>
  let currentFilter = 'all';

  function setFilter(type, btn) {
    currentFilter = type;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    applyFilter();
  }

  function applyFilter() {
    document.querySelectorAll('.crop-card').forEach(card => {
      const match = currentFilter === 'all' || card.dataset.type === currentFilter;
      card.classList.toggle('hidden', !match);
    });
  }

  function manualRefresh() {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spinning');
    setTimeout(() => location.reload(), 300);
  }

  // Auto-refresh every 10 seconds so new scans appear without manual refresh
  let countdown = 10;
  setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      location.reload();
    }
  }, 1000);
</script>
</body>
</html>`;
}

// ─── Route registration ───────────────────────────────────────────────────────

// How long to keep crops on disk before auto-purging (default: 30 minutes).
// Raise this if you want crops to survive longer for post-scan inspection.
const CROP_MAX_AGE_MS = Number(process.env.DEBUG_CROP_MAX_AGE_MS || 30 * 60 * 1000);

function purgeStaleCrops() {
  try {
    if (!fs.existsSync(DEBUG_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(DEBUG_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
    let purged = 0;
    for (const f of files) {
      try {
        const mtime = fs.statSync(path.join(DEBUG_DIR, f)).mtimeMs;
        if (now - mtime > CROP_MAX_AGE_MS) {
          fs.unlinkSync(path.join(DEBUG_DIR, f));
          purged++;
        }
      } catch {}
    }
    if (purged > 0) console.log(`🧹 [cropDebug] Purged ${purged} stale crops (>${CROP_MAX_AGE_MS / 60000}min old)`);
  } catch {}
}

function registerCropDebugRoutes(app) {
  // NOTE: Do NOT register express.static("/ocr_debug") here.
  // server.js already does: app.use('/ocr_debug', express.static(OCR_DEBUG_DIR))
  // Registering it again here causes a double-handler conflict and can produce
  // 404s if __dirname resolves differently. Let server.js own that route.

  // Main viewer page
  app.get("/debug/crops", (req, res) => {
    const files = listDebugFiles();
    res.send(buildPage(files));
  });

  // JSON API — useful for external tooling / future React UI
  app.get("/debug/crops/json", (req, res) => {
    const files = listDebugFiles();
    const annotated = files.map(f => ({
      filename: f,
      url: `/ocr_debug/${encodeURIComponent(f)}`,
      ...classifyFile(f),
      sizeKb: (() => {
        try { return +(fs.statSync(path.join(DEBUG_DIR, f)).size / 1024).toFixed(1); } catch { return 0; }
      })(),
      mtimeMs: (() => {
        try { return fs.statSync(path.join(DEBUG_DIR, f)).mtimeMs; } catch { return 0; }
      })()
    }));
    res.json({ count: annotated.length, files: annotated });
  });

  // DELETE all crops — handy "clear" button hook
  app.delete("/debug/crops", (req, res) => {
    try {
      const files = fs.readdirSync(DEBUG_DIR).filter(f => /\.(png|jpg|jpeg)$/i.test(f));
      files.forEach(f => { try { fs.unlinkSync(path.join(DEBUG_DIR, f)); } catch {} });
      res.json({ deleted: files.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run an initial purge on startup, then every 5 minutes
  purgeStaleCrops();
  setInterval(purgeStaleCrops, 5 * 60 * 1000);

  console.log("🔬 Crop debug viewer mounted at: /debug/crops");
}

module.exports = { registerCropDebugRoutes };
