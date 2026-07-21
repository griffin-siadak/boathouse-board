// Boathouse Board backend — zero dependencies (Node 22+).
// Serves the static front end and a whole-state JSON API backed by SQLite.
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const PORT = process.env.PORT || 4173;
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "boathouse.db");

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS fleet (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    cls             TEXT DEFAULT '',
    notes           TEXT DEFAULT '',
    retired         INTEGER DEFAULT 0,
    hw_refresh_date TEXT,
    last_full_wash_date TEXT,
    last_inspection_date TEXT,
    last_measurement_check_date TEXT
  );
  CREATE TABLE IF NOT EXISTS checkouts (
    id          TEXT PRIMARY KEY,
    boat_id     TEXT NOT NULL,
    out_at      TEXT NOT NULL,
    in_at       TEXT,
    note        TEXT DEFAULT '',
    person      TEXT DEFAULT '',
    person_role TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS maintenance (
    id          TEXT PRIMARY KEY,
    boat_id     TEXT NOT NULL,
    date        TEXT NOT NULL,
    description TEXT NOT NULL,
    severity    TEXT DEFAULT 'minor',
    resolved    INTEGER DEFAULT 0,
    resolved_at TEXT,
    source      TEXT DEFAULT 'manual'
  );
`);

// Migrations for databases created before a column existed
function ensureColumn(table, col, ddl) {
  const cols = db.prepare("PRAGMA table_info(" + table + ")").all().map(r => r.name);
  if (!cols.includes(col)) db.exec("ALTER TABLE " + table + " ADD COLUMN " + ddl);
}
ensureColumn("fleet", "hw_refresh_date", "hw_refresh_date TEXT");
// 2026-07: "last wax" became "last full wash" — rename preserves existing data
{
  const cols = db.prepare("PRAGMA table_info(fleet)").all().map(r => r.name);
  if (cols.includes("last_wax_date") && !cols.includes("last_full_wash_date"))
    db.exec("ALTER TABLE fleet RENAME COLUMN last_wax_date TO last_full_wash_date");
}
ensureColumn("fleet", "last_full_wash_date", "last_full_wash_date TEXT");
ensureColumn("fleet", "last_inspection_date", "last_inspection_date TEXT");
ensureColumn("fleet", "last_measurement_check_date", "last_measurement_check_date TEXT");
ensureColumn("checkouts", "person", "person TEXT DEFAULT ''");
ensureColumn("checkouts", "person_role", "person_role TEXT DEFAULT ''");

// ---------- state <-> tables ----------
function getState() {
  const fleet = db.prepare("SELECT * FROM fleet").all().map(r => ({
    id: r.id, name: r.name, cls: r.cls, notes: r.notes, retired: !!r.retired,
    hwRefreshDate: r.hw_refresh_date || "",
    lastFullWashDate: r.last_full_wash_date || "",
    lastInspectionDate: r.last_inspection_date || "",
    lastMeasurementCheckDate: r.last_measurement_check_date || ""
  }));
  const checkouts = db.prepare("SELECT * FROM checkouts ORDER BY out_at").all().map(r => ({
    id: r.id, boatId: r.boat_id, outAt: r.out_at, inAt: r.in_at, note: r.note,
    person: r.person || "", personRole: r.person_role || ""
  }));
  const maintenance = db.prepare("SELECT * FROM maintenance ORDER BY date").all().map(r => {
    const m = {
      id: r.id, boatId: r.boat_id, date: r.date, description: r.description,
      severity: r.severity, resolved: !!r.resolved, source: r.source
    };
    if (r.resolved_at) m.resolvedAt = r.resolved_at;
    return m;
  });
  return { fleet, checkouts, maintenance };
}

function putState(state) {
  const fleet = Array.isArray(state.fleet) ? state.fleet : [];
  const checkouts = Array.isArray(state.checkouts) ? state.checkouts : [];
  const maintenance = Array.isArray(state.maintenance) ? state.maintenance : [];

  const insFleet = db.prepare(
    "INSERT INTO fleet (id, name, cls, notes, retired, hw_refresh_date, last_full_wash_date, last_inspection_date, last_measurement_check_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const insCheckout = db.prepare(
    "INSERT INTO checkouts (id, boat_id, out_at, in_at, note, person, person_role) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const insMaint = db.prepare(
    "INSERT INTO maintenance (id, boat_id, date, description, severity, resolved, resolved_at, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM fleet; DELETE FROM checkouts; DELETE FROM maintenance;");
    for (const b of fleet)
      insFleet.run(b.id, b.name, b.cls || "", b.notes || "", b.retired ? 1 : 0,
        b.hwRefreshDate || null, b.lastFullWashDate || null,
        b.lastInspectionDate || null, b.lastMeasurementCheckDate || null);
    for (const c of checkouts)
      insCheckout.run(c.id, c.boatId, c.outAt, c.inAt || null, c.note || "",
        c.person || "", c.personRole || "");
    for (const m of maintenance)
      insMaint.run(m.id, m.boatId, m.date, m.description, m.severity || "minor",
        m.resolved ? 1 : 0, m.resolvedAt || null, m.source || "manual");
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ---------- http ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/state") {
    if (req.method === "GET") {
      return sendJson(res, 200, getState());
    }
    if (req.method === "PUT") {
      let body = "";
      req.on("data", chunk => {
        body += chunk;
        if (body.length > 5_000_000) req.destroy(); // sanity cap
      });
      req.on("end", () => {
        try {
          putState(JSON.parse(body));
          sendJson(res, 200, { ok: true });
        } catch (e) {
          sendJson(res, 400, { error: "bad state payload" });
        }
      });
      return;
    }
    return sendJson(res, 405, { error: "method not allowed" });
  }

  // static files
  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  file = path.normalize(file).replace(/^([.][.][/\\])+/, "");
  const full = path.join(__dirname, file);
  if (!full.startsWith(__dirname) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => {
  console.log("Boathouse Board listening on http://localhost:" + PORT);
  console.log("Database: " + DB_PATH);
});
