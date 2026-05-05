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
  resolved INTEGER NOT NULL DEFAULT 0
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

CREATE INDEX IF NOT EXISTS idx_alerts_fired_at ON alerts_history(fired_at);
CREATE INDEX IF NOT EXISTS idx_reports_generated_at ON reports_history(generated_at);
CREATE INDEX IF NOT EXISTS idx_chat_user_created ON chat_history(user_id, created_at);
`);

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
        `INSERT INTO alerts_history (contact_id, contact_name, phone, lead_added_at, minutes_elapsed) VALUES (?, ?, ?, ?, ?)`
      )
      .run(a.contactId, a.contactName, a.phone, a.leadAddedAt, a.minutesElapsed),
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
