// Jobber Warehouse — full local mirror of Jobber data for the Control Room.
//
// PURPOSE
// Instead of asking Jobber's API live on every question (slow, costly, capped
// at ~20 records), we keep a complete local copy of Jobber in SQLite and answer
// questions from that copy. This module owns the ingestion side only.
//
// DESIGN
// - Additive & isolated: creates its own jw_* tables via the shared db handle.
//   Does NOT touch any alert/report/cron code in index.js, alerts.js, etc.
// - Nightly FULL re-pull that upserts by Jobber id (idempotent). Data volume is
//   small (~25k records), so a full refresh is simpler and more robust than
//   fragile incremental cursors, and stays well within Jobber's rate limits
//   (2500 req / 5 min; ~10k-point cost budget restoring 500/s).
// - The one-time backfill is just runFullSync() executed once.
// - Every row also stores the full raw node JSON, so no field is ever lost even
//   if we didn't break it out into its own column.
//
// SCHEMA NOTES (verified live against Jobber GraphQL 2025-04-16):
//   clients/requests/quotes/jobs/invoices/users are top-level connections.
//   updatedAt exists on clients/requests/quotes/jobs/invoices.
//   Quote amount is nested: amounts { total }.  Payments are NOT a top-level
//   list — invoice.paymentsTotal carries the paid amount.
//
// Auth/transport is reused from ./jobber.js (gql()).

import cron from "node-cron";
import express from "express";
import { gql } from "./jobber.js";
import { db } from "./db.js";

const TZ = "America/New_York";
const PAGE_SIZE = 50; // cost-conscious page size
const PAGE_CAP = 1000; // safety cap on pages per object
const SECRET = process.env.JWT_BOOTSTRAP_SECRET || "lac-jwt-2026-bootstrap-axabramov";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS jw_clients (
  id TEXT PRIMARY KEY,
  name TEXT, company_name TEXT, first_name TEXT, last_name TEXT,
  created_at TEXT, updated_at TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_requests (
  id TEXT PRIMARY KEY,
  title TEXT, status TEXT, company_name TEXT, contact_name TEXT, email TEXT,
  client_id TEXT, created_at TEXT, updated_at TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_quotes (
  id TEXT PRIMARY KEY,
  quote_number TEXT, status TEXT, total REAL,
  client_id TEXT, created_at TEXT, updated_at TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_jobs (
  id TEXT PRIMARY KEY,
  job_number TEXT, title TEXT, status TEXT, total REAL,
  client_id TEXT, start_at TEXT, end_at TEXT, created_at TEXT, updated_at TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_invoices (
  id TEXT PRIMARY KEY,
  invoice_number TEXT, subject TEXT, status TEXT, total REAL, payments_total REAL,
  client_id TEXT, issued_date TEXT, created_at TEXT, updated_at TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_users (
  id TEXT PRIMARY KEY,
  name TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_visits (
  id TEXT PRIMARY KEY,
  kind TEXT, title TEXT, start_at TEXT, end_at TEXT, job_id TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_sync_state (
  object TEXT PRIMARY KEY,
  last_run_at TEXT, last_count INTEGER, last_ok INTEGER, last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jw_requests_created ON jw_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_jw_quotes_created ON jw_quotes(created_at);
CREATE INDEX IF NOT EXISTS idx_jw_jobs_created ON jw_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jw_invoices_issued ON jw_invoices(issued_date);
`);

// ---------------------------------------------------------------------------
// Generic cursor pagination
// ---------------------------------------------------------------------------
// buildQuery(first, after) must return a GraphQL string whose top field is the
// connection. extract(data) returns { nodes, pageInfo }. onNode(node) upserts.
async function paginate({ label, buildQuery, extract, onNode }) {
  let after = null;
  let pages = 0;
  let count = 0;
  while (pages < PAGE_CAP) {
    const data = await gql(buildQuery(PAGE_SIZE, after));
    const conn = extract(data);
    const nodes = conn?.nodes || [];
    for (const node of nodes) {
      try {
        onNode(node);
        count++;
      } catch (e) {
        console.warn(`[jw] ${label} upsert failed for ${node?.id}:`, e.message);
      }
    }
    pages++;
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return count;
}

function recordState(object, ok, count, error) {
  db.prepare(
    `INSERT INTO jw_sync_state (object, last_run_at, last_count, last_ok, last_error)
     VALUES (?, CURRENT_TIMESTAMP, ?, ?, ?)
     ON CONFLICT(object) DO UPDATE SET
       last_run_at = CURRENT_TIMESTAMP, last_count = excluded.last_count,
       last_ok = excluded.last_ok, last_error = excluded.last_error`
  ).run(object, count ?? 0, ok ? 1 : 0, error || null);
}

// ---------------------------------------------------------------------------
// Per-object sync functions
// ---------------------------------------------------------------------------
async function syncClients() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_clients
       (id, name, company_name, first_name, last_name, created_at, updated_at, raw, synced_at)
     VALUES (@id, @name, @company_name, @first_name, @last_name, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "clients",
    buildQuery: (first, after) => `query { clients(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id name companyName firstName lastName createdAt updatedAt
        emails { description address } phones { description number } }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.clients,
    onNode: (n) => up.run({
      id: n.id, name: n.name || null, company_name: n.companyName || null,
      first_name: n.firstName || null, last_name: n.lastName || null,
      created_at: n.createdAt || null, updated_at: n.updatedAt || null,
      raw: JSON.stringify(n),
    }),
  });
}

async function syncRequests() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_requests
       (id, title, status, company_name, contact_name, email, client_id, created_at, updated_at, raw, synced_at)
     VALUES (@id, @title, @status, @company_name, @contact_name, @email, @client_id, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "requests",
    buildQuery: (first, after) => `query { requests(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id title requestStatus companyName contactName email createdAt updatedAt client { id } }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.requests,
    onNode: (n) => up.run({
      id: n.id, title: n.title || null, status: n.requestStatus || null,
      company_name: n.companyName || null, contact_name: n.contactName || null,
      email: n.email || null, client_id: n.client?.id || null,
      created_at: n.createdAt || null, updated_at: n.updatedAt || null,
      raw: JSON.stringify(n),
    }),
  });
}

async function syncQuotes() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_quotes
       (id, quote_number, status, total, client_id, created_at, updated_at, raw, synced_at)
     VALUES (@id, @quote_number, @status, @total, @client_id, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "quotes",
    buildQuery: (first, after) => `query { quotes(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id quoteNumber quoteStatus amounts { total } createdAt updatedAt client { id } }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.quotes,
    onNode: (n) => up.run({
      id: n.id, quote_number: n.quoteNumber || null, status: n.quoteStatus || null,
      total: n.amounts?.total ?? null, client_id: n.client?.id || null,
      created_at: n.createdAt || null, updated_at: n.updatedAt || null,
      raw: JSON.stringify(n),
    }),
  });
}

async function syncJobs() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_jobs
       (id, job_number, title, status, total, client_id, start_at, end_at, created_at, updated_at, raw, synced_at)
     VALUES (@id, @job_number, @title, @status, @total, @client_id, @start_at, @end_at, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "jobs",
    buildQuery: (first, after) => `query { jobs(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id jobNumber title jobStatus total startAt endAt createdAt updatedAt client { id } }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.jobs,
    onNode: (n) => up.run({
      id: n.id, job_number: n.jobNumber != null ? String(n.jobNumber) : null,
      title: n.title || null, status: n.jobStatus || null, total: n.total ?? null,
      client_id: n.client?.id || null, start_at: n.startAt || null, end_at: n.endAt || null,
      created_at: n.createdAt || null, updated_at: n.updatedAt || null,
      raw: JSON.stringify(n),
    }),
  });
}

async function syncInvoices() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_invoices
       (id, invoice_number, subject, status, total, payments_total, client_id, issued_date, created_at, updated_at, raw, synced_at)
     VALUES (@id, @invoice_number, @subject, @status, @total, @payments_total, @client_id, @issued_date, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "invoices",
    buildQuery: (first, after) => `query { invoices(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id invoiceNumber subject invoiceStatus total paymentsTotal issuedDate createdAt updatedAt client { id } }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.invoices,
    onNode: (n) => up.run({
      id: n.id, invoice_number: n.invoiceNumber != null ? String(n.invoiceNumber) : null,
      subject: n.subject || null, status: n.invoiceStatus || null,
      total: n.total ?? null, payments_total: n.paymentsTotal ?? null,
      client_id: n.client?.id || null, issued_date: n.issuedDate || null,
      created_at: n.createdAt || null, updated_at: n.updatedAt || null,
      raw: JSON.stringify(n),
    }),
  });
}

async function syncUsers() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_users (id, name, raw, synced_at)
     VALUES (@id, @name, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "users",
    buildQuery: (first, after) => `query { users(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id name { full } } pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.users,
    onNode: (n) => up.run({ id: n.id, name: n.name?.full || null, raw: JSON.stringify(n) }),
  });
}

// Visits/assessments require a date filter. Scoped from 2023 forward.
async function syncVisits(sinceIso = "2023-01-01T00:00:00Z") {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_visits (id, kind, title, start_at, end_at, job_id, raw, synced_at)
     VALUES (@id, @kind, @title, @start_at, @end_at, @job_id, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "visits",
    buildQuery: (first, after) => `query { scheduledItems(first: ${first}${after ? `, after: "${after}"` : ""}, filter: { startAt: { after: "${sinceIso}" } }) {
      nodes {
        ... on Visit { id title startAt endAt job { id } }
        ... on Assessment { id title startAt endAt }
      }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.scheduledItems,
    onNode: (n) => up.run({
      id: n.id, kind: n.job ? "visit" : "scheduled", title: n.title || null,
      start_at: n.startAt || null, end_at: n.endAt || null, job_id: n.job?.id || null,
      raw: JSON.stringify(n),
    }),
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------
const JOBS = [
  ["clients", syncClients],
  ["requests", syncRequests],
  ["quotes", syncQuotes],
  ["jobs", syncJobs],
  ["invoices", syncInvoices],
  ["users", syncUsers],
  ["visits", syncVisits],
];

export async function runFullSync() {
  const started = Date.now();
  const results = {};
  for (const [name, fn] of JOBS) {
    try {
      const count = await fn();
      results[name] = { ok: true, count };
      recordState(name, true, count, null);
      console.log(`[jw] synced ${name}: ${count}`);
    } catch (e) {
      results[name] = { ok: false, error: e.message };
      recordState(name, false, 0, e.message);
      console.error(`[jw] sync ${name} FAILED:`, e.message);
    }
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(`[jw] full sync done in ${seconds}s`, results);
  return { seconds, results };
}

export function warehouseStatus() {
  const tables = ["jw_clients", "jw_requests", "jw_quotes", "jw_jobs", "jw_invoices", "jw_users", "jw_visits"];
  const counts = {};
  for (const t of tables) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
    catch { counts[t] = null; }
  }
  const state = db.prepare(`SELECT * FROM jw_sync_state`).all();
  return { counts, state };
}

// Self-scheduled nightly full re-pull at 00:15 America/New_York.
// Scheduled from here (not index.js) so we never touch the protected cron block.
let scheduled = false;
export function initJobberWarehouse() {
  if (scheduled) return;
  scheduled = true;
  cron.schedule(
    "15 0 * * *",
    async () => {
      console.log("[jw-cron] nightly Jobber warehouse sync starting");
      try { await runFullSync(); } catch (e) { console.error("[jw-cron] failed:", e.message); }
    },
    { timezone: TZ }
  );
  console.log("[jw] nightly warehouse sync scheduled for 00:15 " + TZ);
}

// ---------------------------------------------------------------------------
// Admin router (secret-gated; mounted from server.js BEFORE requireAuth)
// ---------------------------------------------------------------------------
export function buildJobberWarehouseRouter() {
  const router = express.Router();

  router.get("/admin/jobber/wh/status/" + SECRET, (req, res) => {
    res.json({ ok: true, ...warehouseStatus() });
  });

  // Kick off a full sync/backfill. Long-running: respond immediately and run in
  // background so the HTTP request doesn't time out on the first big backfill.
  router.get("/admin/jobber/wh/sync/" + SECRET, (req, res) => {
    const wait = req.query.wait === "1";
    if (wait) {
      runFullSync()
        .then((r) => res.json({ ok: true, ...r }))
        .catch((e) => res.status(500).json({ ok: false, error: e.message }));
    } else {
      runFullSync().catch((e) => console.error("[jw] background sync error:", e.message));
      res.json({ ok: true, started: true, note: "Sync running in background. Poll /admin/jobber/wh/status/<secret>." });
    }
  });

  return router;
}
