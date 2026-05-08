// SQLite database for users + auth + alert/report archive.
// Lives at /var/data/control-room.db on Render (persistent disk),
// or ./data/control-room.db locally.
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import bcrypt from "bcrypt";

// Pick a writable data dir: explicit override → Render persistent disk → local ./data → /tmp fallback
function pickDataDir() {
  const candidates = [
    process.env.DATA_DIR,
    process.env.RENDER ? "/var/data" : null,
    path.resolve("./data"),
    "/tmp/control-room",
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Probe writability
      fs.accessSync(dir, fs.constants.W_OK);
      if (dir !== candidates[0]) {
        console.warn(`[db] using ${dir} (preferred dir not writable)`);
      }
      return dir;
    } catch (e) {
      // try next candidate
    }
  }
  throw new Error("No writable data directory found");
}

const DB_DIR = pickDataDir();
const DB_PATH = path.join(DB_DIR, "control-room.db");
console.log(`[db] storing data at ${DB_PATH}`);

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT,
  role TEXT NOT NULL DEFAULT 'manager',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS alerts_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id TEXT,
  contact_name TEXT,
  phone TEXT,
  lead_added_at TEXT,
  fired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  minutes_elapsed INTEGER,
  resolved INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1 -- 1 = warning (3 min), 2 = escalation (10 min)
);

CREATE TABLE IF NOT EXISTS reports_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL, -- 'morning' | 'evening'
  generated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  html_body TEXT,
  summary_json TEXT
);

CREATE TABLE IF NOT EXISTS chat_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL, -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Persistent call log. Sources: 'webhook' (live), 'firehose' (backfill/reconcile).
-- Primary key is HighLevel's callSid (unique per call). UPSERT on conflict so the
-- nightly firehose reconcile job can fill in dispositions / duration / status that
-- weren't known when the webhook fired (calls are reported BEFORE final disposition).
CREATE TABLE IF NOT EXISTS calls (
  call_sid TEXT PRIMARY KEY,
  direction TEXT,                 -- 'outbound' | 'inbound'
  status TEXT,                    -- 'completed' | 'no-answer' | 'failed' | 'busy' | 'ringing'
  duration INTEGER,               -- seconds
  user_id TEXT,                   -- GHL user (dispatcher) ID; null for inbound
  contact_id TEXT,
  phone TEXT,
  source TEXT NOT NULL,           -- 'webhook' | 'firehose'
  date_added TEXT NOT NULL,       -- ISO timestamp from GHL (call event time)
  raw_event TEXT,                 -- JSON of the original event/row
  inserted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_alerts_fired_at ON alerts_history(fired_at);
CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports_history(generated_at);
CREATE INDEX IF NOT EXISTS idx_chat_user_created ON chat_history(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_calls_date ON calls(date_added);
CREATE INDEX IF NOT EXISTS idx_calls_user ON calls(user_id, date_added);
`);

// ---------- Idempotent migrations (for DBs created before a column existed) ----------
function addColumnIfMissing(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[db] migrated: added ${table}.${column}`);
  }
}
addColumnIfMissing("alerts_history", "level", "INTEGER NOT NULL DEFAULT 1");

// ---------- Seed admin if no users exist ----------
const userCount = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
if (userCount === 0) {
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (adminEmail && adminPassword) {
    const hash = bcrypt.hashSync(adminPassword, 12);
    db.prepare(
      `INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')`
    ).run(adminEmail.toLowerCase(), hash, "Alex");
    console.log(`[db] seeded admin user ${adminEmail}`);
  } else {
    console.warn(
      "[db] no users in DB and no ADMIN_EMAIL/ADMIN_PASSWORD env vars — login will reject everyone until you add a user manually."
    );
  }
}

// ---------- Helpers ----------
export const Users = {
  findByEmail: (email) =>
    db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get((email || "").toLowerCase()),
  findById: (id) => db.prepare("SELECT * FROM users WHERE id = ?").get(id),
  create: ({ email, password, name, role = "manager" }) => {
    const hash = bcrypt.hashSync(password, 12);
    const result = db
      .prepare(
        "INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)"
      )
      .run(email.toLowerCase(), hash, name || null, role);
    return result.lastInsertRowid;
  },
  list: () =>
    db
      .prepare(
        "SELECT id, email, name, role, created_at, last_login_at FROM users ORDER BY created_at"
      )
      .all(),
  recordLogin: (id) =>
    db
      .prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(id),
  verify: (email, password) => {
    const u = Users.findByEmail(email);
    if (!u) return null;
    const ok = bcrypt.compareSync(password, u.password_hash);
    if (!ok) return null;
    Users.recordLogin(u.id);
    return u;
  },
};

export const Alerts = {
  log: (a) =>
    db
      .prepare(
        `INSERT INTO alerts_history (contact_id, contact_name, phone, lead_added_at, minutes_elapsed, level) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        a.contactId,
        a.contactName,
        a.phone,
        a.leadAddedAt,
        a.minutesElapsed,
        a.level ?? 1
      ),
  recent: (limit = 50) =>
    db
      .prepare("SELECT * FROM alerts_history ORDER BY fired_at DESC LIMIT ?")
      .all(limit),
  todayCount: () =>
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM alerts_history WHERE date(fired_at) = date('now', 'localtime')"
      )
      .get().n,
};

export const Reports = {
  log: ({ kind, html, summary }) =>
    db
      .prepare(
        "INSERT INTO reports_history (kind, html_body, summary_json) VALUES (?, ?, ?)"
      )
      .run(kind, html, summary ? JSON.stringify(summary) : null),
  recent: (limit = 30) =>
    db
      .prepare(
        "SELECT id, kind, generated_at, summary_json FROM reports_history ORDER BY generated_at DESC LIMIT ?"
      )
      .all(limit),
  byId: (id) =>
    db.prepare("SELECT * FROM reports_history WHERE id = ?").get(id),
};

// Detect whether a call was live-transferred. HighLevel encodes this in the
// `participants` field — an OBJECT (not array) keyed by participant call SID.
// Each value has a `label` string. When the call was transferred, one of
// the labels starts with "transfer:" followed by the destination phone number.
//   participants: {
//     "CA<sid1>": { label: "dialer",   joinedAt, leftAt, callStatus },
//     "CA<sid2>": { label: "contact",  joinedAt, leftAt, callStatus },
//     "CA<sid3>": { label: "transfer:+15167847773", ... }
//   }
// Verified on May 7 against ground-truth call_ids 63b9DO6cUhkvEhOPHITv and
// lcK3oKOgOPoN24FO2dQz, both transferred to +15167847773 (sales line).
export function isLiveTransfer(row) {
  const participants = row?.participants || {};
  return Object.values(participants).some(
    (p) => typeof p?.label === "string" && p.label.startsWith("transfer:")
  );
}

// Extract the transfer destination phone number ("+15167847773") for the
// "transferred to" column on the report. Empty string when not transferred.
export function transferDestination(row) {
  const participants = row?.participants || {};
  const lbl = Object.values(participants)
    .map((p) => p?.label || "")
    .find((l) => l.startsWith("transfer:"));
  return lbl ? lbl.slice("transfer:".length) : "";
}

// Real-call duration threshold (seconds). Calls under this duration that
// completed (i.e. picked up but didn't actually engage, or stayed on the line
// briefly during a transfer attempt) are bucketed as No Answer rather than
// Real Call. The user calibrated this at 70s — short conversations under 70s
// are reliably "didn't really talk" and shouldn't count as real engagement.
// DO NOT lower without explicit user instruction. Override via env var if
// ever needed; default stays 70.
const REAL_CALL_MIN_DURATION = Number(
  process.env.REAL_CALL_MIN_DURATION || 70
);

// Bucket classification for the 5-category daily breakdown:
//   Live Transfer   = completed + duration >= 70s + isLiveTransfer(row)
//   Real Call       = completed + duration >= 70s + NOT isLiveTransfer(row)
//   No Answer       = status='no-answer' OR (status='completed' AND duration<70s)
//   Failed          = status in ('failed','busy')
//   Ringing         = status in ('ringing','queued','initiated','in-progress')
//
// row may be either a firehose row (has .participants directly) or a DB row
// (raw participants live inside raw_event JSON, the caller of bucketCounts
// re-hydrates that into row before passing here).
export function classifyCall(row) {
  const s = (row.status || row.callStatus || "").toLowerCase();
  const d = Number(row.duration || 0);
  if (s === "completed" && d >= REAL_CALL_MIN_DURATION && isLiveTransfer(row))
    return "live_transfer";
  if (s === "completed" && d >= REAL_CALL_MIN_DURATION) return "real_call";
  if (s === "no-answer" || (s === "completed" && d < REAL_CALL_MIN_DURATION))
    return "no_answer";
  if (s === "failed" || s === "busy") return "failed";
  return "ringing";
}

export const Calls = {
  // Idempotent upsert. Webhooks (real-time) and firehose (reconcile) both call this.
  // The webhook may arrive before HL has a final status; the firehose reconcile
  // overwrites status/duration when the call is finalized.
  upsert: (c) => {
    const stmt = db.prepare(`
      INSERT INTO calls (call_sid, direction, status, duration, user_id, contact_id, phone, source, date_added, raw_event, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(call_sid) DO UPDATE SET
        direction = COALESCE(excluded.direction, direction),
        status = COALESCE(excluded.status, status),
        duration = COALESCE(excluded.duration, duration),
        user_id = COALESCE(excluded.user_id, user_id),
        contact_id = COALESCE(excluded.contact_id, contact_id),
        phone = COALESCE(excluded.phone, phone),
        -- Prefer 'firehose' as source-of-truth once it's seen the call
        source = CASE WHEN excluded.source = 'firehose' THEN 'firehose' ELSE source END,
        date_added = COALESCE(excluded.date_added, date_added),
        raw_event = excluded.raw_event,
        updated_at = CURRENT_TIMESTAMP
    `);
    return stmt.run(
      c.callSid,
      c.direction || null,
      c.status || null,
      c.duration ?? null,
      c.userId || null,
      c.contactId || null,
      c.phone || null,
      c.source || "webhook",
      c.dateAdded,
      c.raw ? JSON.stringify(c.raw) : null
    );
  },
  // Bulk upsert in a single transaction (used by firehose backfill).
  bulkUpsert: (rows) => {
    const tx = db.transaction((items) => {
      for (const r of items) Calls.upsert(r);
    });
    tx(rows);
    return rows.length;
  },
  // Total count between two ISO timestamps (UTC), optionally by direction.
  countInWindow: (fromIso, toIso, direction) => {
    if (direction) {
      return db
        .prepare(
          "SELECT COUNT(*) AS n FROM calls WHERE date_added >= ? AND date_added < ? AND direction = ?"
        )
        .get(fromIso, toIso, direction).n;
    }
    return db
      .prepare(
        "SELECT COUNT(*) AS n FROM calls WHERE date_added >= ? AND date_added < ?"
      )
      .get(fromIso, toIso).n;
  },
  // Per-userId counts for outbound calls in a window (drives the dispatcher rollup).
  byUserCount: (fromIso, toIso, direction = "outbound") =>
    db
      .prepare(
        `SELECT user_id, COUNT(*) AS n
         FROM calls
         WHERE date_added >= ? AND date_added < ? AND direction = ?
         GROUP BY user_id`
      )
      .all(fromIso, toIso, direction),
  // 5-bucket counts (live_transfer / real_call / no_answer / failed / ringing).
  // Computed in JS so the classifyCall() rule stays in one place.
  bucketCounts: (fromIso, toIso) => {
    const rows = db
      .prepare(
        "SELECT status, duration, raw_event FROM calls WHERE date_added >= ? AND date_added < ?"
      )
      .all(fromIso, toIso);
    const counts = {
      live_transfer: 0,
      real_call: 0,
      no_answer: 0,
      failed: 0,
      ringing: 0,
    };
    for (const r of rows) {
      let raw = {};
      try {
        if (r.raw_event) raw = JSON.parse(r.raw_event);
      } catch {}
      const bucket = classifyCall({
        status: r.status,
        duration: r.duration,
        participants: raw.participants,
      });
      counts[bucket]++;
    }
    return counts;
  },
  // Direct row fetch (debug/admin).
  listInWindow: (fromIso, toIso, limit = 1000) =>
    db
      .prepare(
        "SELECT * FROM calls WHERE date_added >= ? AND date_added < ? ORDER BY date_added DESC LIMIT ?"
      )
      .all(fromIso, toIso, limit),
};

export const Chat = {
  append: ({ userId, role, content }) =>
    db
      .prepare(
        "INSERT INTO chat_history (user_id, role, content) VALUES (?, ?, ?)"
      )
      .run(userId, role, content),
  recent: (userId, limit = 50) =>
    db
      .prepare(
        "SELECT role, content, created_at FROM chat_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(userId, limit)
      .reverse(),
  clear: (userId) =>
    db.prepare("DELETE FROM chat_history WHERE user_id = ?").run(userId),
};
