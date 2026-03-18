import { type ReportData } from "./load.js"

export function generateReportHTML(data: ReportData): string {
  const dataJson = JSON.stringify(data).replace(/</g, "\\u003c")

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>shinyloadtest Report</title>
  <style>
${CSS}
  </style>
</head>
<body>
  <div class="layout">
    <button class="mobile-menu-toggle" id="menu-toggle" aria-label="Toggle navigation">
      <svg width="20" height="20" viewBox="0 0 20 20"><rect y="3" width="20" height="2" rx="1"/><rect y="9" width="20" height="2" rx="1"/><rect y="15" width="20" height="2" rx="1"/></svg>
    </button>
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <nav class="sidebar" id="sidebar">
      <h1 class="sidebar-title">shinyloadtest</h1>
      <div class="sidebar-run-select" id="sidebar-run-select">
        <label for="run-select">Run</label>
        <select id="run-select"></select>
      </div>
      <ul class="nav-list">
        <li><a href="#" class="nav-link active" data-section="sessions"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/></svg>Sessions</a></li>
        <li><a href="#" class="nav-link" data-section="session-duration"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 7v10"/><path d="M6 5v14"/><rect width="12" height="18" x="10" y="3" rx="2"/></svg>Session Duration</a></li>
        <li><a href="#" class="nav-link" data-section="waterfall"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/><path d="M15 3v18"/></svg>Event Waterfall</a></li>
        <li><a href="#" class="nav-link" data-section="latency"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>Latency</a></li>
        <li><a href="#" class="nav-link" data-section="event-duration"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>Event Duration</a></li>
        <li><a href="#" class="nav-link" data-section="event-concurrency"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/></svg>Event Concurrency</a></li>
      </ul>
    </nav>
    <main class="content">
      <section id="sessions" class="section active">
        <div class="section-desc">
          <p id="sessions-desc">Simulated users executing back-to-back sessions. Warmup or cooldown sessions (desaturated) start before or end after the vertical dotted line. Narrower event bars mean better performance.</p>
        </div>
        <div id="sessions-chart" class="chart-area"></div>
      </section>
      <section id="session-duration" class="section">
        <div class="section-desc">
          <p id="session-duration-desc">Maintenance sessions ordered from fastest to slowest completion time. The red line marks how long the original recording session took to complete. Sessions should end around the same time as each other for consistent behavior.</p>
        </div>
        <div id="session-duration-chart" class="chart-area"></div>
      </section>
      <section id="waterfall" class="section">
        <div class="section-desc">
          <p>Each session is represented with a line that cascades downward from each event. As time progresses, the line moves to the right. Consistent behavior is represented with parallel lines, whereas inconsistent behavior has lines jut arbitrarily to the right. Warmup and cooldown sessions are included as grey lines.</p>
        </div>
        <div id="waterfall-chart" class="chart-area"></div>
      </section>
      <section id="latency" class="section">
        <div class="section-desc">
          <div class="sub-tabs">
            <button class="sub-tab active" data-subtab="http-latency">Total HTTP</button>
            <button class="sub-tab" data-subtab="ws-latency">Maximum WebSocket</button>
          </div>
        </div>
        <div id="http-latency" class="chart-area sub-content active">
          <p class="chart-desc">Total HTTP and supporting files (JS/CSS) latency (load time) is displayed for each session. Each vertical bar represents the amount of time a session's Shiny application had to wait before it could ask the server for information. A reasonable time to wait has been set to 5s. Warmup and cooldown sessions are displayed outside the dotted maintenance period lines.</p>
          <div id="http-latency-chart"></div>
        </div>
        <div id="ws-latency" class="chart-area sub-content">
          <p class="chart-desc">Maximum WebSocket latency (calculation time) is displayed for each session. The maximum time is shown to convey the longest amount of time a user would have to wait for a response from the Shiny server. Warmup and cooldown sessions are displayed outside the dotted maintenance period lines.</p>
          <div id="ws-latency-chart"></div>
        </div>
      </section>
      <section id="event-duration" class="section">
        <div class="section-desc">
          <div class="sub-tabs">
            <button class="sub-tab active" data-subtab="dur-max">Slowest max</button>
            <button class="sub-tab" data-subtab="dur-min">Slowest min</button>
            <button class="sub-tab" data-subtab="dur-mean-diff" id="dur-mean-diff-tab" style="display:none">Largest mean difference</button>
            <button class="sub-tab" data-subtab="dur-table">Data table</button>
          </div>
        </div>
        <div id="dur-max" class="chart-area sub-content active">
          <p class="chart-desc">Event plots are arranged by the slowest <strong>maximum</strong> time within each plot.</p>
          <div id="dur-max-grid"></div>
        </div>
        <div id="dur-min" class="chart-area sub-content">
          <p class="chart-desc">Event plots are arranged by the slowest <strong>minimum</strong> time within each plot.</p>
          <div id="dur-min-grid"></div>
        </div>
        <div id="dur-mean-diff" class="chart-area sub-content">
          <p class="chart-desc">Event plots are arranged by the largest <strong>mean difference</strong> across runs.</p>
          <div id="dur-mean-diff-grid"></div>
        </div>
        <div id="dur-table" class="chart-area sub-content">
          <div id="dur-table-content"></div>
        </div>
      </section>
      <section id="event-concurrency" class="section">
        <div class="section-desc">
          <div class="sub-tabs">
            <button class="sub-tab active" data-subtab="conc-slope">Largest slope</button>
            <button class="sub-tab" data-subtab="conc-intercept">Largest intercept</button>
            <button class="sub-tab" data-subtab="conc-error">Largest error</button>
            <button class="sub-tab" data-subtab="conc-table">Data table</button>
          </div>
        </div>
        <div id="conc-slope" class="chart-area sub-content active">
          <p class="chart-desc">Event plots are arranged by the largest <strong>slope magnitude</strong> found when fitting a line to each run.</p>
          <div id="conc-slope-grid"></div>
        </div>
        <div id="conc-intercept" class="chart-area sub-content">
          <p class="chart-desc">Event plots are arranged by the largest <strong>intercept magnitude</strong> found when fitting a line to each run.</p>
          <div id="conc-intercept-grid"></div>
        </div>
        <div id="conc-error" class="chart-area sub-content">
          <p class="chart-desc">Event plots are arranged by the largest <strong>residual error</strong> found when fitting a line to each run.</p>
          <div id="conc-error-grid"></div>
        </div>
        <div id="conc-table" class="chart-area sub-content">
          <div id="conc-table-content"></div>
        </div>
      </section>
    </main>
  </div>

  <script type="module">
import * as Plot from "https://cdn.jsdelivr.net/npm/@observablehq/plot@0.6.16/+esm";
import * as aq from "https://cdn.jsdelivr.net/npm/arquero@7.2.1/+esm";
import * as d3 from "https://cdn.jsdelivr.net/npm/d3@7/+esm";

const RAW_DATA = ${dataJson};

${CLIENT_JS}
  </script>
</body>
</html>`
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
/* ======================================================================
   Light theme (default)
   ====================================================================== */
:root {
  --bg: #ffffff;
  --bg-muted: #f5f7fb;
  --bg-card: #ffffff;
  --bg-sidebar: #f5f7fb;
  --text: #264964;
  --text-secondary: #6c8399;
  --text-nav: #3f7aa6;
  --text-nav-active: #264964;
  --accent: #75aadb;
  --accent-dark: #5a8bb5;
  --border: rgba(117, 170, 219, 0.25);
  --shadow-card: 0 0 10px #e2ecf4;
  --shadow-sidebar: inset 0 0 5px rgba(117, 170, 219, 0.3);
  --radius: 6px;
  --table-header-bg: #75aadb;
  --table-header-text: #ffffff;
  --table-stripe: #f8fafd;
  --table-hover: #edf3fa;
  --table-border: #e8eef5;
  color-scheme: light dark;
}

/* ======================================================================
   Dark theme
   ====================================================================== */
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1a1b26;
    --bg-muted: #1f2133;
    --bg-card: #24253a;
    --bg-sidebar: #1f2133;
    --text: #c0cfe0;
    --text-secondary: #8899aa;
    --text-nav: #8bb8e0;
    --text-nav-active: #d0e4f7;
    --accent: #75aadb;
    --accent-dark: #5a8bb5;
    --border: rgba(117, 170, 219, 0.2);
    --shadow-card: 0 0 10px rgba(0,0,0,0.3);
    --shadow-sidebar: inset 0 0 5px rgba(0,0,0,0.3);
    --table-header-bg: #2d3a56;
    --table-header-text: #c0cfe0;
    --table-stripe: #1e2030;
    --table-hover: #2a2d44;
    --table-border: #2a2d44;
  }
}

/* ======================================================================
   Reset & base
   ====================================================================== */
*, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
  font-size: 15px;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
  height: 100vh;
  overflow: hidden;
}

/* ======================================================================
   Layout
   ====================================================================== */
.layout {
  display: flex;
  height: 100vh;
}

/* Mobile menu toggle (hidden on desktop) */
.mobile-menu-toggle {
  display: none;
  position: fixed;
  top: 10px;
  left: 10px;
  z-index: 200;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  cursor: pointer;
  color: var(--text);
  box-shadow: var(--shadow-card);
  line-height: 0;
}
.mobile-menu-toggle svg { display: block; fill: currentColor; }

/* Overlay to close sidebar on mobile */
.sidebar-overlay {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 140;
  background: rgba(0,0,0,0.3);
}
.sidebar-overlay.visible { display: block; }

/* ======================================================================
   Sidebar
   ====================================================================== */
.sidebar {
  width: min-content;
  min-width: min-content;
  background: var(--bg-sidebar);
  box-shadow: var(--shadow-sidebar);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding-top: 1.5rem;
  z-index: 150;
}

.sidebar-title {
  font-family: 'Inconsolata', 'Menlo', 'Consolas', monospace;
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text);
  padding: 0.25rem 1.5rem 1.25rem;
  margin: 0;
}

.nav-list {
  list-style: none;
}

.nav-list li {
  padding: 0;
}

.nav-link {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0.65rem 1.5rem;
  color: var(--text-nav);
  text-decoration: none;
  font-size: 14px;
  font-weight: 500;
  border-left: 3px solid transparent;
  border-top: 1px solid transparent;
  border-bottom: 1px solid transparent;
  transition: all 0.15s;
}

.nav-link:hover {
  color: var(--text-nav-active);
  background: rgba(117, 170, 219, 0.06);
}

.nav-link.active {
  background: var(--bg);
  color: var(--text-nav-active);
  font-weight: 600;
  border-top-color: var(--border);
  border-bottom-color: var(--border);
  box-shadow: 1px 0 var(--bg);
}

.nav-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  color: currentColor;
  opacity: 0.7;
  stroke-width: 1.5;
}

.nav-link.active .nav-icon { opacity: 1; }

/* Sidebar run selector */
.sidebar-run-select {
  padding: 0 1.5rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sidebar-run-select label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.sidebar-run-select select {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 13px;
  background: var(--bg-card);
  color: var(--text);
}

/* ======================================================================
   Content area
   ====================================================================== */
.content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-width: 0;
}

/* ======================================================================
   Sections
   ====================================================================== */
.section {
  display: none;
  flex-direction: column;
  overflow-y: auto;
  flex: 1;
}

.section.active { display: flex; }

.section-desc {
  position: sticky;
  top: 0;
  z-index: 90;
  background: var(--bg);
  padding: 1.5rem 2rem 0;
}

.section-desc p {
  font-size: 14px;
  color: var(--text-secondary);
  max-width: 900px;
  padding-bottom: 1rem;
}

.chart-area {
  flex: 1;
  padding: 0 2rem 2rem;
}

.chart-area figure,
.chart-area > svg {
  max-width: 100%;
  height: auto;
}

.chart-desc {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 12px;
  max-width: 900px;
}

/* ======================================================================
   Sub-tabs (segmented buttons)
   ====================================================================== */
.sub-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
}

.sub-tab {
  padding: 8px 22px;
  border: 1px solid var(--accent);
  background: transparent;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  color: var(--accent);
  transition: all 0.15s;
}

.sub-tab:first-child { border-radius: var(--radius) 0 0 var(--radius); }
.sub-tab:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
.sub-tab:not(:first-child) { border-left: none; }

.sub-tab:hover {
  background: rgba(117, 170, 219, 0.1);
  color: var(--accent-dark);
}

.sub-tab.active {
  background: var(--accent);
  color: #fff;
}

.sub-content { display: none; }
.sub-content.active { display: block; }

/* ======================================================================
   Chart grid (small multiples)
   ====================================================================== */
.chart-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 16px;
  max-width: 1200px;
}

.chart-grid-item {
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
  border-radius: var(--radius);
  padding: 12px 14px;
}

.chart-grid-item h4 {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chart-grid-item figure {
  width: 100%;
  margin: 0;
}

.chart-grid-item svg {
  width: 100% !important;
  height: auto !important;
}

/* ======================================================================
   Data tables
   ====================================================================== */
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.data-table thead th {
  position: sticky;
  top: 0;
  text-align: center;
  padding: 10px 12px;
  background: var(--table-header-bg);
  color: var(--table-header-text);
  font-weight: 700;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
}

.data-table thead th:first-child {
  text-align: left;
  padding-left: 1.5rem;
}

.data-table tbody td {
  padding: 9px 12px;
  border-bottom: 1px solid var(--table-border);
  text-align: center;
}

.data-table tbody td:first-child {
  text-align: left;
  padding-left: 1.5rem;
}

.data-table tbody tr:nth-child(even) { background: var(--table-stripe); }
.data-table tbody tr:hover { background: var(--table-hover); }

/* ======================================================================
   Grid picker & run label
   ====================================================================== */
.grid-picker {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.grid-picker input {
  width: 60px;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-card);
  color: var(--text);
  font-size: 13px;
  text-align: center;
}

.chart-tooltip {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
  background: rgba(255, 255, 255, 0.96);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 13px;
  line-height: 1.4;
  color: var(--text);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  max-width: 320px;
  white-space: pre-line;
  transition: opacity 0.15s;
}

.run-panel-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

/* ======================================================================
   Observable Plot overrides
   ====================================================================== */
figure { margin: 0; }

[aria-label="tip"] { z-index: 300; }

@media (prefers-color-scheme: dark) {
  /* Override Observable Plot default text colors */
  svg[class^="plot-"] text,
  svg[class*=" plot-"] text,
  figure svg text {
    fill: var(--text) !important;
  }
  figure svg [aria-label="axis"] line,
  figure svg [aria-label="axis"] path {
    stroke: var(--border) !important;
  }
  figure svg [aria-label="grid"] line {
    stroke: var(--border) !important;
  }
}

/* ======================================================================
   Legend
   ====================================================================== */
.legend {
  display: flex;
  gap: 16px;
  padding: 8px 0;
  flex-wrap: wrap;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}

.legend-swatch {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
}

/* ======================================================================
   Responsive: small tablets (< 768px)
   ====================================================================== */
@media (max-width: 768px) {
  .mobile-menu-toggle { display: block; }

  .sidebar {
    position: fixed;
    top: 0;
    left: 0;
    width: 220px;
    min-width: 220px;
    height: 100vh;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: none;
  }

  .sidebar.open {
    transform: translateX(0);
    box-shadow: 4px 0 20px rgba(0,0,0,0.15);
  }

  /* Offset content so toggle doesn't overlap text */
  .section-desc { padding: 1rem 1rem 0; padding-top: 48px; }
  .section-desc:not(:first-child) { padding-top: 1rem; }
  .chart-area { padding: 0 1rem 1rem; }

  .sub-tab {
    padding: 6px 14px;
    font-size: 12px;
  }
}

/* ======================================================================
   Responsive: phones (< 480px)
   ====================================================================== */
@media (max-width: 480px) {
  .sub-tabs {
    flex-wrap: wrap;
    gap: 4px;
  }

  .sub-tab {
    border-radius: var(--radius) !important;
    border-left: 1px solid var(--accent) !important;
  }

  .section-desc { padding: 0.75rem 0.75rem 0; }
  .chart-area { padding: 0 0.75rem 1rem; }

  .data-table { font-size: 12px; }
  .data-table thead th,
  .data-table tbody td { padding: 7px 8px; }

  .legend { gap: 10px; }
}

/* ======================================================================
   Print
   ====================================================================== */
@media print {
  .sidebar, .mobile-menu-toggle, .content-header { display: none !important; }
  .section { display: flex !important; page-break-after: always; }
  .layout { display: block; }
  .content { overflow: visible; }
}
`

// ---------------------------------------------------------------------------
// Client-side JavaScript (runs in browser)
// ---------------------------------------------------------------------------

const CLIENT_JS = `
// =========================================================================
// Event classification & colors
// =========================================================================

const EVENT_TYPE_MAP = {
  REQ_HOME: "Homepage",
  REQ_GET: "JS/CSS",
  WS_OPEN: "Start Session",
  WS_RECV: "Calculate",
};

const EVENT_COLORS = {
  Homepage: "#f28983",
  "JS/CSS": "#fdc086",
  "Start Session": "#9cffd9",
  Calculate: "#75aadb",
};

const EVENT_ORDER = ["Homepage", "JS/CSS", "Start Session", "Calculate"];

const RUN_COLORS = [
  "#7fc97f","#beaed4","#fdc086","#f28983","#7ddbb6","#75aadb",
  "#5d945d","#9084a1","#c9996b","#bd5c57","#5fa68a","#5981a6",
  "#9efa9e","#e5d1ff","#8df5cc","#88c6ff","#3d613d","#625a6e",
  "#967250","#8a433f","#467362","#3d5973"
];

// Recording label lookup (generated server-side)
const recordingLabelMap = new Map(
  RAW_DATA.recording.events.map(e => [e.lineNumber, e.label])
);

function getRecordingLabel(lineNum) {
  return recordingLabelMap.get(lineNum) || ("Event " + lineNum);
}

// =========================================================================
// Data processing
// =========================================================================

function processRun(run) {
  const rows = [...run.rows].sort((a, b) => a.timestamp - b.timestamp);
  if (rows.length === 0) return { name: run.name, paired: [] };

  const minTs = rows[0].timestamp;

  let cumConc = 0;
  const normalized = rows.map(row => {
    if (row.event === "WS_OPEN_START") cumConc++;
    else if (row.event === "WS_CLOSE_END") cumConc--;
    return {
      ...row,
      ts: (row.timestamp - minTs) / 1000,
      concurrency: Math.max(cumConc, 0),
    };
  });

  const relevant = normalized.filter(d =>
    !d.event.startsWith("PLAYBACK") &&
    d.event !== "PLAYER_SESSION_CREATE" &&
    d.event !== "PLAYBACK_DONE" &&
    d.input_line_number > 0
  );

  const groups = new Map();
  for (const row of relevant) {
    const key = row.session_id + "," + row.worker_id + "," + row.iteration + "," + row.input_line_number;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const paired = [];
  for (const [, groupRows] of groups) {
    const start = Math.min(...groupRows.map(r => r.ts));
    const end = Math.max(...groupRows.map(r => r.ts));
    const concSum = groupRows.reduce((s, r) => s + r.concurrency, 0);
    const baseEvent = groupRows[0].event.replace(/_(START|END)$/, "");

    paired.push({
      session_id: groupRows[0].session_id,
      worker_id: groupRows[0].worker_id,
      iteration: groupRows[0].iteration,
      input_line_number: groupRows[0].input_line_number,
      event_base: baseEvent,
      start,
      end,
      time: end - start,
      concurrency: concSum / groupRows.length,
    });
  }

  const maintenance = identifyMaintenance(paired);

  return {
    name: run.name,
    paired: paired.map(r => ({
      ...r,
      maintenance: maintenance.has(r.session_id),
    })),
  };
}

function identifyMaintenance(events) {
  const byWorker = new Map();
  for (const e of events) {
    if (!byWorker.has(e.worker_id)) byWorker.set(e.worker_id, []);
    byWorker.get(e.worker_id).push(e);
  }

  if (byWorker.size <= 1) {
    return new Set(events.map(e => e.session_id));
  }

  let latestStart = -Infinity;
  let earliestEnd = Infinity;
  for (const [, workerEvents] of byWorker) {
    const starts = workerEvents.map(e => e.start);
    const ends = workerEvents.map(e => e.end);
    latestStart = Math.max(latestStart, Math.min(...starts));
    earliestEnd = Math.min(earliestEnd, Math.max(...ends));
  }

  const bySess = new Map();
  for (const e of events) {
    if (!bySess.has(e.session_id)) bySess.set(e.session_id, { min: Infinity, max: -Infinity });
    const s = bySess.get(e.session_id);
    s.min = Math.min(s.min, e.start);
    s.max = Math.max(s.max, e.end);
  }

  const maintenanceSessions = new Set();
  for (const [sid, range] of bySess) {
    if (range.min >= latestStart && range.max <= earliestEnd) {
      maintenanceSessions.add(sid);
    }
  }

  if (maintenanceSessions.size === 0) {
    return new Set(events.map(e => e.session_id));
  }

  return maintenanceSessions;
}

// =========================================================================
// Process all runs
// =========================================================================

const runs = RAW_DATA.runs.map(processRun);
const recordingDuration = RAW_DATA.recording.duration / 1000;
let currentRunIdx = 0;

// Shared x-axis domains across runs
const globalSessionsXDomain = [
  d3.min(runs, run => d3.min(run.paired, d => d.start)) || 0,
  d3.max(runs, run => d3.max(run.paired, d => d.end)) || 1,
];

// =========================================================================
// Run selector
// =========================================================================

const runSelect = document.getElementById("run-select");
runs.forEach((run, i) => {
  const opt = document.createElement("option");
  opt.value = i;
  opt.textContent = run.name;
  runSelect.appendChild(opt);
});

runSelect.addEventListener("change", () => {
  currentRunIdx = Number(runSelect.value);
  updateUrlState({ run: currentRunIdx > 0 ? currentRunIdx : null });
  renderPerRun();
});

if (runs.length <= 1) {
  document.getElementById("sidebar-run-select").style.display = "none";
}

// Show multi-run sub-tabs
if (runs.length > 1) {
  const meanDiffTab = document.getElementById("dur-mean-diff-tab");
  if (meanDiffTab) meanDiffTab.style.display = "";
}

// =========================================================================
// URL state management
// =========================================================================

function getUrlState() {
  const params = new URLSearchParams(window.location.search);
  return {
    section: params.get("section") || "sessions",
    tab: params.get("tab"),
    run: params.get("run"),
  };
}

function updateUrlState(updates) {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(updates)) {
    if (value !== null && value !== undefined) {
      params.set(key, String(value));
    } else {
      params.delete(key);
    }
  }
  const qs = params.toString();
  const url = window.location.pathname + (qs ? "?" + qs : "");
  window.history.replaceState(null, "", url);
}

// =========================================================================
// Navigation
// =========================================================================

const sidebar = document.getElementById("sidebar");
const menuToggle = document.getElementById("menu-toggle");
const sidebarOverlay = document.getElementById("sidebar-overlay");

function openSidebar() {
  sidebar.classList.add("open");
  sidebarOverlay.classList.add("visible");
}
function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarOverlay.classList.remove("visible");
}

menuToggle.addEventListener("click", () => {
  sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
});
sidebarOverlay.addEventListener("click", closeSidebar);

const VALID_SECTIONS = new Set(["sessions", "session-duration", "waterfall", "latency", "event-duration", "event-concurrency"]);

function navigateToSection(sectionId, pushState) {
  if (!VALID_SECTIONS.has(sectionId)) return;
  document.querySelectorAll(".nav-link").forEach(l => l.classList.remove("active"));
  const link = document.querySelector('.nav-link[data-section="' + sectionId + '"]');
  if (link) link.classList.add("active");
  document.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
  const section = document.getElementById(sectionId);
  if (section) section.classList.add("active");
  if (pushState !== false) updateUrlState({ section: sectionId, tab: null });
}

function navigateToSubTab(sectionEl, tabId, pushState) {
  if (!sectionEl) return;
  const tab = sectionEl.querySelector('.sub-tab[data-subtab="' + CSS.escape(tabId) + '"]');
  if (!tab) return;
  sectionEl.querySelectorAll(".sub-tab").forEach(t => t.classList.remove("active"));
  tab.classList.add("active");
  sectionEl.querySelectorAll(".sub-content").forEach(c => c.classList.remove("active"));
  const content = document.getElementById(tabId);
  if (content) content.classList.add("active");
  if (pushState !== false) updateUrlState({ tab: tabId });
}

document.querySelectorAll(".nav-link").forEach(link => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    navigateToSection(link.dataset.section);
    closeSidebar();
  });
});

document.querySelectorAll(".sub-tabs").forEach(tabGroup => {
  tabGroup.querySelectorAll(".sub-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      navigateToSubTab(tab.closest(".section"), tab.dataset.subtab);
    });
  });
});

// =========================================================================
// Helpers
// =========================================================================

function eventLegend() {
  const div = document.createElement("div");
  div.className = "legend";
  for (const label of EVENT_ORDER) {
    const item = document.createElement("span");
    item.className = "legend-item";
    item.innerHTML = '<span class="legend-swatch" style="background:' + EVENT_COLORS[label] + '"></span>' + label;
    div.appendChild(item);
  }
  return div;
}

function runLegend() {
  if (runs.length <= 1) return null;
  const div = document.createElement("div");
  div.className = "legend";
  runs.forEach((run, i) => {
    const item = document.createElement("span");
    item.className = "legend-item";
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = RUN_COLORS[i % RUN_COLORS.length];
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(run.name));
    div.appendChild(item);
  });
  return div;
}

function currentData() {
  return runs[currentRunIdx];
}

function classifiedRunData(run) {
  return run.paired
    .filter(d => d.maintenance && EVENT_TYPE_MAP[d.event_base])
    .map(d => ({ ...d, eventLabel: EVENT_TYPE_MAP[d.event_base] }));
}

function clearChart(id) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = "";
  return el;
}

const CHART_WIDTH = 1200;

// Shared tooltip element
const tooltip = document.createElement("div");
tooltip.className = "chart-tooltip";
tooltip.style.opacity = "0";
document.body.appendChild(tooltip);

let hideTimer = null;

function enableTooltips(chartEl) {
  const elems = chartEl.querySelectorAll("title");
  for (const titleEl of elems) {
    const parent = titleEl.parentElement;
    if (!parent) continue;
    const text = titleEl.textContent;
    titleEl.remove();
    parent.setAttribute("role", "img");
    parent.setAttribute("aria-label", text);
    parent.addEventListener("mouseenter", (e) => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      tooltip.textContent = text;
      tooltip.style.opacity = "1";
      const rect = parent.getBoundingClientRect();
      tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 340) + "px";
      tooltip.style.top = (rect.top - tooltip.offsetHeight - 6) + "px";
      if (parseFloat(tooltip.style.top) < 0) {
        tooltip.style.top = (rect.bottom + 6) + "px";
      }
    });
    parent.addEventListener("mousemove", (e) => {
      tooltip.style.left = Math.min(e.clientX + 12, window.innerWidth - 340) + "px";
    });
    parent.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(() => { tooltip.style.opacity = "0"; }, 500);
    });
  }
}

function makeGridPicker(totalEvents, defaultCount, onChangeCallback) {
  const count = Math.min(defaultCount, totalEvents);
  const picker = document.createElement("div");
  picker.className = "grid-picker";
  picker.innerHTML = "Show <input type='number' value='" + count + "' min='1' max='" + totalEvents + "'> of " + totalEvents + " events";
  const input = picker.querySelector("input");
  input.addEventListener("input", () => {
    const val = Math.max(1, Math.min(totalEvents, Number(input.value) || count));
    onChangeCallback(val);
  });
  return { picker, getCount: () => Math.max(1, Math.min(totalEvents, Number(input.value) || count)) };
}

function makeSortableTable(el, columns, rows, defaultSortCol, defaultSortAsc) {
  let sortCol = defaultSortCol;
  let sortAsc = defaultSortAsc;
  const fmt = (v) => v !== undefined && v !== null ? (typeof v === "number" ? v.toFixed(3) : String(v)) : "";

  function render() {
    const sorted = [...rows].sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "number" && typeof bv === "number") return sortAsc ? av - bv : bv - av;
      return sortAsc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
    });

    const table = document.createElement("table");
    table.className = "data-table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    columns.forEach(col => {
      const th = document.createElement("th");
      th.textContent = col.label + (sortCol === col.key ? (sortAsc ? " \\u25B2" : " \\u25BC") : "");
      th.style.cursor = "pointer";
      th.addEventListener("click", () => {
        if (sortCol === col.key) { sortAsc = !sortAsc; } else { sortCol = col.key; sortAsc = false; }
        render();
      });
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of sorted) {
      const tr = document.createElement("tr");
      columns.forEach(col => {
        const td = document.createElement("td");
        td.textContent = fmt(row[col.key]);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    el.innerHTML = "";
    el.appendChild(table);
  }

  render();
}

// =========================================================================
// 1. Sessions Gantt (per-run)
// =========================================================================

function renderSessions() {
  const el = clearChart("sessions-chart");
  const data = currentData().paired
    .filter(d => EVENT_TYPE_MAP[d.event_base])
    .map(d => ({ ...d, eventLabel: EVENT_TYPE_MAP[d.event_base], worker: "Worker " + d.worker_id }));

  if (data.length === 0) { el.textContent = "No data"; return; }

  const nWorkers = new Set(data.map(d => d.worker_id)).size;
  const desc = document.getElementById("sessions-desc");
  if (desc) desc.textContent = nWorkers + " simulated user" + (nWorkers !== 1 ? "s" : "") + " executing back-to-back sessions. Warmup or cooldown sessions (desaturated) start before or end after the vertical dotted line. Narrower event bars mean better performance.";

  const maint = data.filter(d => d.maintenance);
  const maintMin = maint.length > 0 ? d3.min(maint, d => d.start) : null;
  const maintMax = maint.length > 0 ? d3.max(maint, d => d.end) : null;

  const workers = [...new Set(data.map(d => d.worker))].sort().reverse();
  const height = Math.max(200, workers.length * 40 + 80);

  const marks = [
    Plot.barX(data, {
      x1: "start",
      x2: "end",
      y: "worker",
      fill: "eventLabel",
      opacity: d => d.maintenance ? 1 : 0.35,
      title: d => getRecordingLabel(d.input_line_number) + "\\n" + d.time.toFixed(2) + "s",
    }),
  ];

  if (maintMin !== null) {
    marks.push(
      Plot.ruleX([maintMin, maintMax], { stroke: "black", strokeDasharray: "4,4", strokeOpacity: 0.7 })
    );
  }

  const chart = Plot.plot({
    width: CHART_WIDTH,
    height,
    marginLeft: 80,
    x: { label: "Elapsed time (sec)", domain: globalSessionsXDomain },
    y: { label: "Simulated user #", domain: workers },
    color: { domain: EVENT_ORDER, range: EVENT_ORDER.map(e => EVENT_COLORS[e]) },
    marks,
  });

  el.appendChild(eventLegend());
  el.appendChild(chart);
  enableTooltips(el);
}

// =========================================================================
// 2. Session Duration (per-run)
// =========================================================================

function renderSessionDuration() {
  const el = clearChart("session-duration-chart");
  const data = classifiedRunData(currentData());
  if (data.length === 0) { el.textContent = "No data"; return; }

  const nSess = new Set(data.map(d => d.session_id)).size;
  const cutoffSec = Math.round(recordingDuration || 60);
  const desc = document.getElementById("session-duration-desc");
  if (desc) desc.textContent = nSess + " maintenance session" + (nSess !== 1 ? "s" : "") + " ordered from fastest to slowest completion time. The red line marks how long the original recording session took to complete (~" + cutoffSec + "s). Sessions should end around the same time as each other for consistent behavior.";

  const bySess = new Map();
  for (const d of data) {
    if (!bySess.has(d.session_id)) bySess.set(d.session_id, Infinity);
    bySess.set(d.session_id, Math.min(bySess.get(d.session_id), d.start));
  }

  const relData = data.map(d => {
    const sessStart = bySess.get(d.session_id);
    return { ...d, relStart: d.start - sessStart, relEnd: d.end - sessStart };
  });

  const sessMaxEnd = new Map();
  for (const d of relData) {
    const cur = sessMaxEnd.get(d.session_id) || 0;
    sessMaxEnd.set(d.session_id, Math.max(cur, d.relEnd));
  }
  const orderedSessions = [...sessMaxEnd.entries()]
    .sort((a, b) => a[1] - b[1])
    .map((d, i) => [d[0], "Session " + i]);
  const sessOrder = new Map(orderedSessions);
  const yDomain = orderedSessions.map(d => d[1]);

  const plotData = relData.map(d => ({
    ...d,
    sessLabel: sessOrder.get(d.session_id),
  }));

  const cutoff = recordingDuration || 60;
  const nSessions = sessOrder.size;
  const maxEnd = d3.max(relData, d => d.relEnd) || 0;
  const xMax = Math.max(maxEnd, cutoff);

  const chart = Plot.plot({
    width: CHART_WIDTH,
    height: Math.max(300, nSessions * 12 + 80),
    marginLeft: 20,
    x: { label: "Time since session start (sec)", domain: [0, xMax * 1.05] },
    y: { label: "Sessions (ordered by total duration)", domain: yDomain, axis: null },
    color: { domain: EVENT_ORDER, range: EVENT_ORDER.map(e => EVENT_COLORS[e]) },
    marks: [
      Plot.barX(plotData, {
        x1: "relStart",
        x2: "relEnd",
        y: "sessLabel",
        fill: "eventLabel",
        title: d => getRecordingLabel(d.input_line_number) + "\\n" + d.time.toFixed(2) + "s",
      }),
      Plot.ruleX([cutoff], { stroke: "red", strokeWidth: 1.5 }),
    ],
  });

  el.appendChild(eventLegend());
  el.appendChild(chart);
  enableTooltips(el);
}

// =========================================================================
// 3. Event Waterfall (per-run)
// =========================================================================

function renderWaterfall() {
  const el = clearChart("waterfall-chart");
  const allData = currentData().paired;
  if (allData.length === 0) { el.textContent = "No data"; return; }

  // Build ordered label list from all recording events (not just those in paired data)
  const labelOrder = RAW_DATA.recording.events.map(e => e.label);

  // Session-relative end times: rebase each session to start at 0
  const sessMin = new Map();
  for (const d of allData) {
    if (!sessMin.has(d.session_id)) sessMin.set(d.session_id, Infinity);
    sessMin.set(d.session_id, Math.min(sessMin.get(d.session_id), d.start));
  }

  const waterfallData = allData
    .map(d => ({
      session_id: d.session_id,
      maintenance: d.maintenance,
      relEnd: d.end - sessMin.get(d.session_id),
      label: getRecordingLabel(d.input_line_number),
      input_line_number: d.input_line_number,
      concurrency: d.concurrency,
    }))
    .sort((a, b) => a.input_line_number - b.input_line_number);

  const maintData = waterfallData.filter(d => d.maintenance);
  const nonMaintData = waterfallData.filter(d => !d.maintenance);
  const maxConc = d3.max(maintData, d => d.concurrency) || 1;

  const maintRelEnds = maintData.map(d => d.relEnd);
  const maintMin = maintRelEnds.length > 0 ? d3.min(maintRelEnds) : null;
  const maintMax = maintRelEnds.length > 0 ? d3.max(maintRelEnds) : null;

  const marks = [];

  // Non-maintenance sessions as grey lines (behind)
  if (nonMaintData.length > 0) {
    marks.push(
      Plot.line(nonMaintData, {
        x: "relEnd",
        y: "label",
        z: "session_id",
        stroke: "#ccc",
        strokeWidth: 1,
        strokeOpacity: 0.4,
      })
    );
  }

  // Maintenance sessions with concurrency coloring
  marks.push(
    Plot.line(maintData, {
      x: "relEnd",
      y: "label",
      z: "session_id",
      stroke: "concurrency",
      strokeWidth: 1.5,
      strokeOpacity: 0.8,
    })
  );

  // Horizontal highlight rule on hover
  marks.push(
    Plot.ruleY(maintData, Plot.pointerY({
      y: "label",
      stroke: "rgba(0,0,0,0.5)",
      strokeWidth: 1,
    }))
  );

  // Maintenance boundary dashed lines
  if (maintMin !== null && nonMaintData.length > 0) {
    marks.push(
      Plot.ruleX([maintMin, maintMax], { stroke: "rgba(0,0,0,0.7)", strokeDasharray: "4,4", strokeWidth: 0.5 })
    );
  }

  const chart = Plot.plot({
    width: CHART_WIDTH,
    height: Math.max(300, labelOrder.length * 20 + 80),
    marginLeft: 240,
    x: { label: "Time since session start (sec)" },
    y: {
      label: null,
      domain: labelOrder,
    },
    color: {
      type: "linear",
      range: ["#413554", "#75aadb", "#9efa9e", "#fdc086"],
      interpolate: "rgb",
      domain: [0, maxConc * 0.33, maxConc * 0.67, maxConc],
      label: "concurrency",
    },
    marks,
  });

  el.appendChild(chart);
}

// =========================================================================
// 4. Latency (all runs faceted)
// =========================================================================

function renderLatency() {
  renderLatencyFaceted("http-latency-chart", ["Homepage", "JS/CSS"], 5);
  renderLatencyFaceted("ws-latency-chart", ["Calculate"], 20);
}

function renderLatencyFaceted(containerId, eventLabels, cutoff) {
  const el = clearChart(containerId);

  for (let ri = 0; ri < runs.length; ri++) {
    const run = runs[ri];
    const data = classifiedRunData(run).filter(d => eventLabels.includes(d.eventLabel));
    if (data.length === 0) continue;

    // Show run name when multiple runs
    if (runs.length > 1) {
      const label = document.createElement("p");
      label.className = "run-panel-label";
      label.textContent = run.name;
      el.appendChild(label);
    }

    // Aggregate per session: sum(time) for each eventLabel
    const bySess = new Map();
    for (const d of data) {
      if (!bySess.has(d.session_id)) bySess.set(d.session_id, []);
      bySess.get(d.session_id).push(d);
    }

    const chartData = [];
    for (const [sid, events] of bySess) {
      for (const label of EVENT_ORDER) {
        const evts = events.filter(e => e.eventLabel === label);
        if (evts.length > 0) {
          const total = d3.sum(evts, e => e.time);
          chartData.push({ session: "S" + sid, eventLabel: label, latency: total, maintenance: evts[0].maintenance });
        }
      }
    }

    // Maintenance boundary lines (session-index mode)
    const maintSessions = [...new Set(chartData.filter(d => d.maintenance).map(d => d.session))];
    const allSessions = [...new Set(chartData.map(d => d.session))];

    const marks = [
      Plot.barY(chartData, eventLabels.length > 1
        ? Plot.stackY({ x: "session", y: "latency", fill: "eventLabel", order: EVENT_ORDER, title: d => d.eventLabel + "\\n" + d.latency.toFixed(2) + "s" })
        : { x: "session", y: "latency", fill: "eventLabel", title: d => d.eventLabel + "\\n" + d.latency.toFixed(2) + "s" }
      ),
      Plot.ruleY([cutoff], { stroke: "red", strokeWidth: 1.5 }),
    ];

    if (maintSessions.length > 0 && maintSessions.length < allSessions.length) {
      const maintIndices = maintSessions.map(s => allSessions.indexOf(s)).filter(i => i >= 0);
      const minIdx = Math.min(...maintIndices);
      const maxIdx = Math.max(...maintIndices);
      // Draw boundaries between maintenance and non-maintenance sessions
      // Use the session labels at the boundary positions
      const boundaryLabels = [];
      if (minIdx > 0) boundaryLabels.push(allSessions[minIdx]);
      if (maxIdx < allSessions.length - 1) boundaryLabels.push(allSessions[maxIdx]);
      if (boundaryLabels.length > 0) {
        marks.push(
          Plot.ruleX(boundaryLabels, { stroke: "rgba(0,0,0,0.7)", strokeDasharray: "4,4" })
        );
      }
    }

    const chart = Plot.plot({
      width: CHART_WIDTH,
      height: 300,
      marginBottom: 30,
      x: { label: null, axis: null },
      y: { label: "Total latency (sec)" },
      color: { domain: EVENT_ORDER, range: EVENT_ORDER.map(e => EVENT_COLORS[e]) },
      marks,
    });

    el.appendChild(chart);
    enableTooltips(chart);
  }

  el.insertBefore(eventLegend(), el.firstChild);
}

// =========================================================================
// 5. Event Duration (all runs)
// =========================================================================

function renderEventDuration() {
  // Build combined data across all runs
  const allData = runs.flatMap((run, ri) =>
    run.paired
      .filter(d => d.maintenance)
      .map(d => ({
        ...d,
        run_name: run.name,
        run_idx: ri,
        label: getRecordingLabel(d.input_line_number),
      }))
  );
  if (allData.length === 0) return;

  // Compute stats per event per run, then aggregate
  const byEventRun = new Map();
  for (const d of allData) {
    const key = d.input_line_number + "|" + d.run_idx;
    if (!byEventRun.has(key)) byEventRun.set(key, { label: d.label, input_line_number: d.input_line_number, event_base: d.event_base, run_idx: d.run_idx, times: [] });
    byEventRun.get(key).times.push(d.time);
  }

  const perRunStats = [...byEventRun.values()].map(g => {
    const times = g.times.sort((a, b) => a - b);
    const n = times.length;
    const mid = Math.floor(n / 2);
    return {
      label: g.label,
      input_line_number: g.input_line_number,
      event_base: g.event_base,
      run_idx: g.run_idx,
      min_time: times[0],
      max_time: times[n - 1],
      mean_time: times.reduce((s, v) => s + v, 0) / n,
      median_time: n % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2,
      count: n,
    };
  });

  // Aggregate across runs per event
  const byEvent = new Map();
  for (const s of perRunStats) {
    if (!byEvent.has(s.input_line_number)) byEvent.set(s.input_line_number, []);
    byEvent.get(s.input_line_number).push(s);
  }

  const stats = [...byEvent.entries()].map(([lineNum, runStats]) => {
    const means = runStats.map(s => s.mean_time);
    return {
      label: runStats[0].label,
      input_line_number: lineNum,
      event_base: runStats[0].event_base,
      min_time: d3.min(runStats, s => s.min_time),
      max_time: d3.max(runStats, s => s.max_time),
      mean_time: d3.mean(means),
      median_time: d3.median(runStats.flatMap(s => [s.median_time])),
      count: d3.sum(runStats, s => s.count),
      mean_diff: means.length > 1 ? d3.max(means) - d3.min(means) : 0,
    };
  });

  const byMax = [...stats].sort((a, b) => b.max_time - a.max_time);
  const byMin = [...stats].sort((a, b) => b.min_time - a.min_time);
  const byMeanDiff = [...stats].sort((a, b) => b.mean_diff - a.mean_diff);

  const totalEvents = stats.length;
  let sharedGridCount = Math.min(12, totalEvents);

  const grids = [
    { id: "dur-max-grid", ordered: byMax },
    { id: "dur-min-grid", ordered: byMin },
  ];
  if (runs.length > 1) {
    grids.push({ id: "dur-mean-diff-grid", ordered: byMeanDiff });
  }

  function buildGrid(container, pickerEl, orderedStats, maxItems) {
    container.innerHTML = "";
    container.appendChild(pickerEl);
    const grid = document.createElement("div");
    grid.className = "chart-grid";
    container.appendChild(grid);

    for (const stat of orderedStats.slice(0, maxItems)) {
      const item = document.createElement("div");
      item.className = "chart-grid-item";
      grid.appendChild(item);

      const title = document.createElement("h4");
      title.textContent = stat.label;
      title.title = stat.label;
      item.appendChild(title);

      const eventData = allData.filter(d => d.input_line_number === stat.input_line_number);

      let chart;
      if (runs.length > 1) {
        chart = Plot.plot({
          height: 160, width: 260, marginLeft: 40, marginRight: 10,
          x: { axis: null, padding: 0.15 },
          y: { label: "Time (sec)", grid: true },
          color: { domain: runs.map(r => r.name), range: runs.map((_, i) => RUN_COLORS[i % RUN_COLORS.length]) },
          marks: [
            Plot.boxY(eventData, { x: "run_name", y: "time", fill: "run_name" }),
          ],
        });
      } else {
        chart = Plot.plot({
          height: 160, width: 260, marginLeft: 40, marginRight: 10,
          x: { axis: null, padding: 0.15 },
          y: { label: "Time (sec)", grid: true },
          marks: [
            Plot.boxY(eventData, { x: () => "", y: "time", fill: EVENT_COLORS[EVENT_TYPE_MAP[stat.event_base]] || "#999" }),
          ],
        });
      }
      item.appendChild(chart);
    }
  }

  const gridState = grids.map(g => {
    const el = clearChart(g.id);
    const { picker } = makeGridPicker(totalEvents, sharedGridCount, (n) => {
      sharedGridCount = n;
      renderAllDurGrids();
    });
    return { el, picker, ordered: g.ordered };
  });

  function renderAllDurGrids() {
    for (const g of gridState) {
      const input = g.picker.querySelector("input");
      if (input) input.value = String(sharedGridCount);
      buildGrid(g.el, g.picker, g.ordered, sharedGridCount);
    }
  }
  renderAllDurGrids();

  // Data table
  const tableCols = [
    { key: "label", label: "Event" },
    { key: "count", label: "Count" },
    { key: "min_time", label: "Min (s)" },
    { key: "mean_time", label: "Mean (s)" },
    { key: "max_time", label: "Max (s)" },
  ];
  if (runs.length > 1) {
    tableCols.push({ key: "mean_diff", label: "Mean Diff" });
  }
  makeSortableTable(clearChart("dur-table-content"), tableCols, stats, "max_time", false);
}

// =========================================================================
// 6. Event Concurrency (all runs)
// =========================================================================

function renderEventConcurrency() {
  const allData = runs.flatMap((run, ri) =>
    run.paired
      .filter(d => d.maintenance)
      .map(d => ({
        ...d,
        run_name: run.name,
        run_idx: ri,
        label: getRecordingLabel(d.input_line_number),
      }))
  );
  if (allData.length === 0) return;

  // Compute linear regression stats per event per run, then pick worst
  const byEventRun = new Map();
  for (const d of allData) {
    const key = d.input_line_number + "|" + d.run_idx;
    if (!byEventRun.has(key)) byEventRun.set(key, []);
    byEventRun.get(key).push(d);
  }

  const perRunStats = [];
  for (const [key, events] of byEventRun) {
    const n = events.length;
    const lineNum = events[0].input_line_number;
    const label = events[0].label;
    const eventBase = events[0].event_base;
    const runIdx = events[0].run_idx;

    if (n < 2) {
      perRunStats.push({ label, input_line_number: lineNum, event_base: eventBase, run_idx: runIdx, slope: 0, intercept: 0, maxError: 0 });
      continue;
    }
    const sumX = d3.sum(events, d => d.concurrency);
    const sumY = d3.sum(events, d => d.time);
    const sumXY = d3.sum(events, d => d.concurrency * d.time);
    const sumX2 = d3.sum(events, d => d.concurrency * d.concurrency);
    const denom = n * sumX2 - sumX * sumX;
    const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
    const intercept = (sumY - slope * sumX) / n;
    const maxError = d3.max(events, d => Math.abs(d.time - (slope * d.concurrency + intercept))) || 0;
    perRunStats.push({ label, input_line_number: lineNum, event_base: eventBase, run_idx: runIdx, slope, intercept, maxError });
  }

  // Aggregate: worst-case across runs per event
  const byEvent = new Map();
  for (const s of perRunStats) {
    if (!byEvent.has(s.input_line_number)) byEvent.set(s.input_line_number, []);
    byEvent.get(s.input_line_number).push(s);
  }

  const stats = [...byEvent.entries()].map(([lineNum, runStats]) => {
    const worstSlope = runStats.reduce((a, b) => Math.abs(a.slope) >= Math.abs(b.slope) ? a : b);
    const worstIntercept = runStats.reduce((a, b) => Math.abs(a.intercept) >= Math.abs(b.intercept) ? a : b);
    const worstError = runStats.reduce((a, b) => a.maxError >= b.maxError ? a : b);
    return {
      label: runStats[0].label,
      input_line_number: lineNum,
      event_base: runStats[0].event_base,
      slope: worstSlope.slope,
      intercept: worstIntercept.intercept,
      maxError: worstError.maxError,
    };
  });

  const bySlope = [...stats].sort((a, b) => Math.abs(b.slope) - Math.abs(a.slope));
  const byIntercept = [...stats].sort((a, b) => Math.abs(b.intercept) - Math.abs(a.intercept));
  const byMaxError = [...stats].sort((a, b) => b.maxError - a.maxError);

  const concTotalEvents = stats.length;
  let sharedConcGridCount = Math.min(12, concTotalEvents);

  const concGrids = [
    { id: "conc-slope-grid", ordered: bySlope },
    { id: "conc-intercept-grid", ordered: byIntercept },
    { id: "conc-error-grid", ordered: byMaxError },
  ];

  function buildConcGrid(container, pickerEl, orderedStats, maxItems) {
    container.innerHTML = "";
    container.appendChild(pickerEl);
    if (runs.length > 1) {
      const legend = runLegend();
      if (legend) container.appendChild(legend);
    }
    const grid = document.createElement("div");
    grid.className = "chart-grid";
    container.appendChild(grid);

    for (const stat of orderedStats.slice(0, maxItems)) {
      const item = document.createElement("div");
      item.className = "chart-grid-item";
      grid.appendChild(item);

      const title = document.createElement("h4");
      title.textContent = stat.label;
      title.title = stat.label;
      item.appendChild(title);

      const eventData = allData.filter(d => d.input_line_number === stat.input_line_number);

      const marks = [];
      if (runs.length > 1) {
        marks.push(
          Plot.dot(eventData, {
            x: "concurrency", y: "time",
            fill: d => RUN_COLORS[d.run_idx % RUN_COLORS.length],
            fillOpacity: 0.6, r: 3,
          })
        );
      } else {
        marks.push(
          Plot.dot(eventData, {
            x: "concurrency", y: "time",
            fill: EVENT_COLORS[EVENT_TYPE_MAP[stat.event_base]] || "#999",
            fillOpacity: 0.6, r: 3,
          })
        );
      }
      marks.push(
        Plot.linearRegressionY(eventData, {
          x: "concurrency", y: "time",
          stroke: "#999", strokeWidth: 1.5,
        })
      );

      const chart = Plot.plot({
        height: 160, width: 260, marginLeft: 40, marginRight: 10,
        x: { label: "Concurrency", grid: true },
        y: { label: "Time (sec)", grid: true },
        marks,
      });
      item.appendChild(chart);
    }
  }

  const concGridState = concGrids.map(g => {
    const el = clearChart(g.id);
    const { picker } = makeGridPicker(concTotalEvents, sharedConcGridCount, (n) => {
      sharedConcGridCount = n;
      renderAllConcGrids();
    });
    return { el, picker, ordered: g.ordered };
  });

  function renderAllConcGrids() {
    for (const g of concGridState) {
      const input = g.picker.querySelector("input");
      if (input) input.value = String(sharedConcGridCount);
      buildConcGrid(g.el, g.picker, g.ordered, sharedConcGridCount);
    }
  }
  renderAllConcGrids();

  // Data table
  makeSortableTable(
    clearChart("conc-table-content"),
    [
      { key: "label", label: "Event" },
      { key: "slope", label: "Slope" },
      { key: "intercept", label: "Intercept" },
      { key: "maxError", label: "Max Error" },
    ],
    stats, "slope", false
  );
}

// =========================================================================
// Render all
// =========================================================================

function renderPerRun() {
  const perRun = [
    ["Sessions", renderSessions],
    ["Session Duration", renderSessionDuration],
    ["Waterfall", renderWaterfall],
  ];
  for (const [name, fn] of perRun) {
    try { fn(); } catch (e) { console.error(name + " render error:", e); }
  }
}

function renderAll() {
  renderPerRun();
  const allRun = [
    ["Latency", renderLatency],
    ["Event Duration", renderEventDuration],
    ["Event Concurrency", renderEventConcurrency],
  ];
  for (const [name, fn] of allRun) {
    try { fn(); } catch (e) { console.error(name + " render error:", e); }
  }
}

renderAll();

// Restore state from URL
const urlState = getUrlState();
const runIdx = Number(urlState.run);
if (Number.isInteger(runIdx) && runIdx >= 0 && runIdx < runs.length) {
  currentRunIdx = runIdx;
  runSelect.value = currentRunIdx;
  renderPerRun();
}
if (urlState.section && urlState.section !== "sessions") {
  navigateToSection(urlState.section, false);
}
if (urlState.tab) {
  const activeSection = document.querySelector(".section.active");
  if (activeSection) navigateToSubTab(activeSection, urlState.tab, false);
}
`
