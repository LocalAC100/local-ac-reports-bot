// Jobber Warehouse — full local mirror of Jobber data for the Control Room.
//
// PURPOSE
// Keep a complete local copy of Jobber in SQLite and answer questions from that
// copy instead of hitting Jobber live on every question.
//
// PHASE A (this version) adds, alongside the core objects:
//   - line items (the products/equipment on quotes, jobs, invoices, requests)
//   - notes (message + author + created/edited timestamps) on every object
//   - an INVENTORY of every note file attachment (fileName, contentType,
//     fileSize, url, thumbnailUrl) — metadata only, NO file downloads yet.
//     Summing file_size tells us how much disk Phase B downloads will need.
//
// DESIGN
// - Additive & isolated: own jw_* tables via the shared db handle. Touches no
//   alert/report/cron code.
// - Nightly FULL re-pull, upsert by id. Notes/line-items/attachments are pulled
//   NESTED in each object's page query (no per-record fan-out) and replaced per
//   parent object on each sync.
// - Throttle-aware with paced pagination.
//
// SCHEMA NOTES (verified live, Jobber GraphQL 2025-04-16):
//   notes -> <Object>NoteUnion (members include ClientNote + the object's own
//     note type). Note fields: message, createdAt, lastEditedAt,
//     createdBy (NoteCreatedByUnion: User/Client/Application),
//     fileAttachments -> NoteFileInterface { fileName contentType fileSize url thumbnailUrl }.
//   lineItems { nodes { name description quantity unitPrice totalPrice } }.

import cron from "node-cron";
import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { gql } from "./jobber.js";
import { db } from "./db.js";
import { sendMail } from "./mailer.js";

// Phase B: where downloaded attachment files live on the persistent disk.
const ATT_DIR = process.env.RENDER ? "/var/data/jw-attachments" : "./data/jw-attachments";
try { fs.mkdirSync(ATT_DIR, { recursive: true }); } catch {}

const TZ = "America/New_York";
let PAGE_SIZE = 5; // enriched (nested) queries are costly; default kept low (tunable via ?first=)
const PAGE_CAP = 2000;
const SECRET = process.env.JWT_BOOTSTRAP_SECRET || "lac-jwt-2026-bootstrap-axabramov";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_DELAY_MS = 1100;

async function gqlThrottleAware(query, attempt = 0) {
  try {
    return await gql(query);
  } catch (e) {
    if (/throttl/i.test(e.message || "") && attempt < 8) {
      await sleep(6000 + attempt * 2000);
      return gqlThrottleAware(query, attempt + 1);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS jw_clients (
  id TEXT PRIMARY KEY, name TEXT, company_name TEXT, first_name TEXT, last_name TEXT,
  created_at TEXT, updated_at TEXT, raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_requests (
  id TEXT PRIMARY KEY, title TEXT, status TEXT, company_name TEXT, contact_name TEXT, email TEXT,
  client_id TEXT, created_at TEXT, updated_at TEXT, raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_quotes (
  id TEXT PRIMARY KEY, quote_number TEXT, status TEXT, total REAL,
  client_id TEXT, created_at TEXT, updated_at TEXT, raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_jobs (
  id TEXT PRIMARY KEY, job_number TEXT, title TEXT, status TEXT, total REAL,
  client_id TEXT, start_at TEXT, end_at TEXT, created_at TEXT, updated_at TEXT,
  assigned_users TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_invoices (
  id TEXT PRIMARY KEY, invoice_number TEXT, subject TEXT, status TEXT, total REAL, payments_total REAL,
  client_id TEXT, issued_date TEXT, created_at TEXT, updated_at TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_users (
  id TEXT PRIMARY KEY, name TEXT, raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_visits (
  id TEXT PRIMARY KEY, kind TEXT, title TEXT, start_at TEXT, end_at TEXT, job_id TEXT,
  assigned_users TEXT,
  raw TEXT, synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jw_sync_state (
  object TEXT PRIMARY KEY, last_run_at TEXT, last_count INTEGER, last_ok INTEGER, last_error TEXT
);
-- Phase A: notes, attachments, line items
CREATE TABLE IF NOT EXISTS jw_line_items (
  id TEXT, object_type TEXT, object_id TEXT, name TEXT, description TEXT,
  quantity REAL, unit_price REAL, total_price REAL, raw TEXT,
  PRIMARY KEY (object_type, object_id, id)
);
CREATE TABLE IF NOT EXISTS jw_notes (
  id TEXT PRIMARY KEY, object_type TEXT, object_id TEXT, message TEXT,
  created_at TEXT, last_edited_at TEXT, created_by_name TEXT, created_by_type TEXT, raw TEXT
);
CREATE TABLE IF NOT EXISTS jw_note_attachments (
  id TEXT PRIMARY KEY, note_id TEXT, object_type TEXT, object_id TEXT,
  file_name TEXT, content_type TEXT, file_size INTEGER, url TEXT, thumbnail_url TEXT,
  created_at TEXT, downloaded INTEGER NOT NULL DEFAULT 0, storage_path TEXT, raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_jw_jobs_created ON jw_jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jw_jobs_start ON jw_jobs(start_at);
CREATE INDEX IF NOT EXISTS idx_jw_invoices_issued ON jw_invoices(issued_date);
CREATE INDEX IF NOT EXISTS idx_jw_notes_obj ON jw_notes(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_jw_line_items_obj ON jw_line_items(object_type, object_id);
CREATE INDEX IF NOT EXISTS idx_jw_att_obj ON jw_note_attachments(object_type, object_id);
`);

// Migration: track the on-disk file hash for dedupe (Phase B downloads).
try { db.exec(`ALTER TABLE jw_note_attachments ADD COLUMN sha256 TEXT`); }
catch (e) { if (!/duplicate column/i.test(e.message || "")) console.warn("[jw] sha256 migration:", e.message); }

// Migration: capture the assigned salesperson(s) on each job (added 2026-05 for the Sales Report).
try { db.exec(`ALTER TABLE jw_jobs ADD COLUMN assigned_users TEXT`); }
catch (e) { if (!/duplicate column/i.test(e.message || "")) console.warn("[jw] assigned_users migration:", e.message); }

// Migration: capture the assigned salesperson on each visit/assessment (the appointment's rep).
try { db.exec(`ALTER TABLE jw_visits ADD COLUMN assigned_users TEXT`); }
catch (e) { if (!/duplicate column/i.test(e.message || "")) console.warn("[jw] visits assigned_users migration:", e.message); }

// ---------------------------------------------------------------------------
// GraphQL fragments for nested notes + line items
// ---------------------------------------------------------------------------
const NOTE_FIELDS = `id message createdAt lastEditedAt
  createdBy { __typename ... on User { id name { full } } ... on Client { id name } }
  fileAttachments(first: 5) { nodes { id fileName contentType fileSize url thumbnailUrl createdAt } }`;

// Cap nested lists with first: — Jobber's query-cost engine charges unbounded
// connections at their MAX, so caps are what keep the page under budget.
// Only fetch the object's own note type (client-level notes are captured under clients).
function notesSelection(ownType) {
  return `notes(first: 8) { nodes { __typename ... on ${ownType} { ${NOTE_FIELDS} } } }`;
}
const LINE_ITEMS = `lineItems(first: 30) { nodes { id name description quantity unitPrice totalPrice } }`;

// ---------------------------------------------------------------------------
// Persisters for nested notes / line items / attachments
// ---------------------------------------------------------------------------
const delNotes = db.prepare(`DELETE FROM jw_notes WHERE object_type = ? AND object_id = ?`);
const delAtt = db.prepare(`DELETE FROM jw_note_attachments WHERE object_type = ? AND object_id = ?`);
const delLines = db.prepare(`DELETE FROM jw_line_items WHERE object_type = ? AND object_id = ?`);
const insNote = db.prepare(
  `INSERT OR REPLACE INTO jw_notes (id, object_type, object_id, message, created_at, last_edited_at, created_by_name, created_by_type, raw)
   VALUES (@id, @object_type, @object_id, @message, @created_at, @last_edited_at, @created_by_name, @created_by_type, @raw)`
);
const insAtt = db.prepare(
  `INSERT OR REPLACE INTO jw_note_attachments (id, note_id, object_type, object_id, file_name, content_type, file_size, url, thumbnail_url, created_at, raw)
   VALUES (@id, @note_id, @object_type, @object_id, @file_name, @content_type, @file_size, @url, @thumbnail_url, @created_at, @raw)`
);
const insLine = db.prepare(
  `INSERT OR REPLACE INTO jw_line_items (id, object_type, object_id, name, description, quantity, unit_price, total_price, raw)
   VALUES (@id, @object_type, @object_id, @name, @description, @quantity, @unit_price, @total_price, @raw)`
);

function createdByName(cb) {
  if (!cb) return { name: null, type: null };
  if (cb.__typename === "User") return { name: cb.name?.full || null, type: "User" };
  if (cb.__typename === "Client") return { name: cb.name || null, type: "Client" };
  return { name: null, type: cb.__typename || null };
}

function persistNotes(objectType, objectId, node) {
  const notes = node.notes?.nodes || [];
  delNotes.run(objectType, objectId);
  delAtt.run(objectType, objectId);
  for (const nt of notes) {
    if (!nt || !nt.id) continue;
    const cb = createdByName(nt.createdBy);
    insNote.run({
      id: nt.id, object_type: objectType, object_id: objectId,
      message: nt.message || null, created_at: nt.createdAt || null,
      last_edited_at: nt.lastEditedAt || null,
      created_by_name: cb.name, created_by_type: cb.type, raw: JSON.stringify(nt),
    });
    const atts = nt.fileAttachments?.nodes || [];
    for (const a of atts) {
      if (!a || !a.id) continue;
      insAtt.run({
        id: a.id, note_id: nt.id, object_type: objectType, object_id: objectId,
        file_name: a.fileName || null, content_type: a.contentType || null,
        file_size: a.fileSize ?? null, url: a.url || null, thumbnail_url: a.thumbnailUrl || null,
        created_at: a.createdAt || null, raw: JSON.stringify(a),
      });
    }
  }
}

function persistLineItems(objectType, objectId, node) {
  const items = node.lineItems?.nodes || [];
  delLines.run(objectType, objectId);
  for (const li of items) {
    if (!li) continue;
    insLine.run({
      id: li.id || `${objectId}-${li.name || "item"}`, object_type: objectType, object_id: objectId,
      name: li.name || null, description: li.description || null,
      quantity: li.quantity ?? null, unit_price: li.unitPrice ?? null, total_price: li.totalPrice ?? null,
      raw: JSON.stringify(li),
    });
  }
}

// ---------------------------------------------------------------------------
// Generic cursor pagination
// ---------------------------------------------------------------------------
async function paginate({ label, buildQuery, extract, onNode }) {
  let after = null, pages = 0, count = 0;
  while (pages < PAGE_CAP) {
    const data = await gqlThrottleAware(buildQuery(PAGE_SIZE, after));
    const conn = extract(data);
    const nodes = conn?.nodes || [];
    for (const node of nodes) {
      try { onNode(node); count++; }
      catch (e) { console.warn(`[jw] ${label} upsert failed for ${node?.id}:`, e.message); }
    }
    pages++;
    if (!conn?.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    await sleep(PAGE_DELAY_MS);
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
// Per-object sync functions (now with nested notes / line items)
// ---------------------------------------------------------------------------
async function syncClients() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_clients (id, name, company_name, first_name, last_name, created_at, updated_at, raw, synced_at)
     VALUES (@id, @name, @company_name, @first_name, @last_name, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "clients",
    buildQuery: (first, after) => `query { clients(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id name companyName firstName lastName createdAt updatedAt
        emails { description address } phones { description number }
        ${notesSelection("ClientNote")} }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.clients,
    onNode: (n) => {
      up.run({
        id: n.id, name: n.name || null, company_name: n.companyName || null,
        first_name: n.firstName || null, last_name: n.lastName || null,
        created_at: n.createdAt || null, updated_at: n.updatedAt || null, raw: JSON.stringify(n),
      });
      persistNotes("client", n.id, n);
    },
  });
}

async function syncRequests() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_requests (id, title, status, company_name, contact_name, email, client_id, created_at, updated_at, raw, synced_at)
     VALUES (@id, @title, @status, @company_name, @contact_name, @email, @client_id, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "requests",
    buildQuery: (first, after) => `query { requests(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id title requestStatus companyName contactName email createdAt updatedAt client { id }
        ${notesSelection("RequestNote")} }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.requests,
    onNode: (n) => {
      up.run({
        id: n.id, title: n.title || null, status: n.requestStatus || null,
        company_name: n.companyName || null, contact_name: n.contactName || null,
        email: n.email || null, client_id: n.client?.id || null,
        created_at: n.createdAt || null, updated_at: n.updatedAt || null, raw: JSON.stringify(n),
      });
      persistNotes("request", n.id, n);
    },
  });
}

async function syncQuotes() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_quotes (id, quote_number, status, total, client_id, created_at, updated_at, raw, synced_at)
     VALUES (@id, @quote_number, @status, @total, @client_id, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "quotes",
    buildQuery: (first, after) => `query { quotes(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id quoteNumber quoteStatus amounts { total } createdAt updatedAt client { id }
        ${LINE_ITEMS} ${notesSelection("QuoteNote")} }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.quotes,
    onNode: (n) => {
      up.run({
        id: n.id, quote_number: n.quoteNumber || null, status: n.quoteStatus || null,
        total: n.amounts?.total ?? null, client_id: n.client?.id || null,
        created_at: n.createdAt || null, updated_at: n.updatedAt || null, raw: JSON.stringify(n),
      });
      persistLineItems("quote", n.id, n);
      persistNotes("quote", n.id, n);
    },
  });
}

async function syncJobs() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_jobs (id, job_number, title, status, total, client_id, start_at, end_at, created_at, updated_at, assigned_users, raw, synced_at)
     VALUES (@id, @job_number, @title, @status, @total, @client_id, @start_at, @end_at, @created_at, @updated_at, @assigned_users, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "jobs",
    buildQuery: (first, after) => `query { jobs(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id jobNumber title jobStatus total startAt endAt createdAt updatedAt client { id }
        visits(first: 3) { nodes { assignedUsers { nodes { id name { full } } } } }
        ${LINE_ITEMS} ${notesSelection("JobNote")} }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.jobs,
    onNode: (n) => {
      up.run({
        id: n.id, job_number: n.jobNumber != null ? String(n.jobNumber) : null,
        title: n.title || null, status: n.jobStatus || null, total: n.total ?? null,
        client_id: n.client?.id || null, start_at: n.startAt || null, end_at: n.endAt || null,
        created_at: n.createdAt || null, updated_at: n.updatedAt || null,
        assigned_users: (() => { const m = {}; (n.visits?.nodes || []).forEach((vv) => (vv.assignedUsers?.nodes || []).forEach((u) => { m[u.id] = u.name?.full || null; })); const a = Object.keys(m).map((id) => ({ id, name: m[id] })); return a.length ? JSON.stringify(a) : null; })(),
        raw: JSON.stringify(n),
      });
      persistLineItems("job", n.id, n);
      persistNotes("job", n.id, n);
    },
  });
}

async function syncInvoices() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_invoices (id, invoice_number, subject, status, total, payments_total, client_id, issued_date, created_at, updated_at, raw, synced_at)
     VALUES (@id, @invoice_number, @subject, @status, @total, @payments_total, @client_id, @issued_date, @created_at, @updated_at, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "invoices",
    buildQuery: (first, after) => `query { invoices(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id invoiceNumber subject invoiceStatus total paymentsTotal issuedDate createdAt updatedAt client { id }
        ${LINE_ITEMS} ${notesSelection("InvoiceNote")} }
      pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.invoices,
    onNode: (n) => {
      up.run({
        id: n.id, invoice_number: n.invoiceNumber != null ? String(n.invoiceNumber) : null,
        subject: n.subject || null, status: n.invoiceStatus || null,
        total: n.total ?? null, payments_total: n.paymentsTotal ?? null,
        client_id: n.client?.id || null, issued_date: n.issuedDate || null,
        created_at: n.createdAt || null, updated_at: n.updatedAt || null, raw: JSON.stringify(n),
      });
      persistLineItems("invoice", n.id, n);
      persistNotes("invoice", n.id, n);
    },
  });
}

async function syncUsers() {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_users (id, name, raw, synced_at) VALUES (@id, @name, @raw, CURRENT_TIMESTAMP)`
  );
  return paginate({
    label: "users",
    buildQuery: (first, after) => `query { users(first: ${first}${after ? `, after: "${after}"` : ""}) {
      nodes { id name { full } } pageInfo { hasNextPage endCursor } } }`,
    extract: (d) => d.users,
    onNode: (n) => up.run({ id: n.id, name: n.name?.full || null, raw: JSON.stringify(n) }),
  });
}

function yearWindows(startYear) {
  const wins = [];
  const nowYear = new Date().getUTCFullYear();
  for (let y = startYear; y <= nowYear; y++) {
    const start = `${y}-01-01T00:00:00Z`;
    const end = y === nowYear ? new Date().toISOString() : `${y + 1}-01-01T00:00:00Z`;
    wins.push([start, end]);
  }
  return wins;
}

async function syncVisits(startYear = 2023) {
  const up = db.prepare(
    `INSERT OR REPLACE INTO jw_visits (id, kind, title, start_at, end_at, job_id, assigned_users, raw, synced_at)
     VALUES (@id, @kind, @title, @start_at, @end_at, @job_id, @assigned_users, @raw, CURRENT_TIMESTAMP)`
  );
  const onNode = (n) => up.run({
    id: n.id, kind: n.job ? "visit" : "scheduled", title: n.title || null,
    start_at: n.startAt || null, end_at: n.endAt || null, job_id: n.job?.id || null,
    assigned_users: (n.assignedUsers?.nodes?.length)
      ? JSON.stringify(n.assignedUsers.nodes.map((u) => ({ id: u.id, name: u.name?.full || null })))
      : null,
    raw: JSON.stringify(n),
  });
  let total = 0;
  for (const [start, end] of yearWindows(startYear)) {
    total += await paginate({
      label: `visits ${start.slice(0, 4)}`,
      buildQuery: (first, after) => `query { scheduledItems(first: ${first}${after ? `, after: "${after}"` : ""}, filter: { occursWithin: { startAt: "${start}", endAt: "${end}" } }) {
        nodes {
          ... on Visit { id title startAt endAt job { id } assignedUsers { nodes { id name { full } } } }
          ... on Assessment { id title startAt endAt assignedUsers { nodes { id name { full } } } }
        }
        pageInfo { hasNextPage endCursor } } }`,
      extract: (d) => d.scheduledItems,
      onNode,
    });
  }
  return total;
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

export async function runFullSync({ only = null } = {}) {
  const started = Date.now();
  const results = {};
  const jobs = only ? JOBS.filter(([name]) => name === only) : JOBS;
  for (const [name, fn] of jobs) {
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
  const tables = [
    "jw_clients", "jw_requests", "jw_quotes", "jw_jobs", "jw_invoices", "jw_users", "jw_visits",
    "jw_notes", "jw_note_attachments", "jw_line_items",
  ];
  const counts = {};
  for (const t of tables) {
    try { counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; }
    catch { counts[t] = null; }
  }
  let attachmentBytes = null;
  try { attachmentBytes = db.prepare(`SELECT COALESCE(SUM(file_size),0) AS b FROM jw_note_attachments`).get().b; }
  catch {}
  const state = db.prepare(`SELECT * FROM jw_sync_state`).all();
  let downloadedCount = 0, downloadedBytes = 0;
  try {
    const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(file_size),0) AS b FROM jw_note_attachments WHERE downloaded = 1`).get();
    downloadedCount = r.n; downloadedBytes = r.b;
  } catch {}
  return {
    counts, attachmentBytes,
    attachmentGB: attachmentBytes != null ? +(attachmentBytes / 1e9).toFixed(3) : null,
    downloadedFiles: downloadedCount, downloadedGB: +(downloadedBytes / 1e9).toFixed(3),
    state,
  };
}

// ---------------------------------------------------------------------------
// Phase B: download the actual attachment files (disk-capped, deduped)
// ---------------------------------------------------------------------------
// Downloads files for attachments created on/after `sinceYear` that aren't yet
// on disk. Hard-capped by maxBytes so it can NEVER fill the 1 GB persistent
// disk (and crash the bot). Re-runnable: only grabs downloaded=0 rows.
export async function downloadAttachments({ sinceYear = 2026, maxBytes = 700 * 1024 * 1024 } = {}) {
  const since = `${sinceYear}-01-01`;
  const rows = db.prepare(
    `SELECT id, url, file_name FROM jw_note_attachments
     WHERE downloaded = 0 AND url IS NOT NULL AND created_at >= ?`
  ).all(since);
  const setDone = db.prepare(`UPDATE jw_note_attachments SET downloaded = 1, storage_path = ?, sha256 = ? WHERE id = ?`);
  let downloaded = 0, bytes = 0, errors = 0, stopped = false;
  for (const r of rows) {
    if (bytes >= maxBytes) { stopped = true; console.warn("[jw-dl] maxBytes cap reached; stopping"); break; }
    try {
      const resp = await axios.get(r.url, {
        responseType: "arraybuffer", timeout: 90000,
        maxContentLength: 200 * 1024 * 1024, maxBodyLength: 200 * 1024 * 1024,
      });
      const buf = Buffer.from(resp.data);
      const sha = crypto.createHash("sha256").update(buf).digest("hex");
      const safe = String(r.file_name || "file").replace(/[^A-Za-z0-9._-]+/g, "_");
      const fp = path.join(ATT_DIR, `${r.id}-${safe}`);
      fs.writeFileSync(fp, buf);
      setDone.run(fp, sha, r.id);
      downloaded++; bytes += buf.length;
    } catch (e) {
      errors++;
      console.warn("[jw-dl] failed", r.id, e.message);
    }
    await sleep(150);
  }
  const result = { candidates: rows.length, downloaded, errors, mb: +(bytes / 1e6).toFixed(1), stopped, sinceYear };
  console.log("[jw-dl] done", result);
  return result;
}

let scheduled = false;
export function initJobberWarehouse() {
  if (scheduled) return;
  scheduled = true;
  cron.schedule(
    "15 0 * * *",
    async () => {
      console.log("[jw-cron] nightly Jobber warehouse sync starting");
      try { await runFullSync(); } catch (e) { console.error("[jw-cron] failed:", e.message); }
      // After the data sync, download 2026+ attachment files (disk-capped).
      try { await downloadAttachments({ sinceYear: 2026 }); } catch (e) { console.error("[jw-cron] download failed:", e.message); }
    },
    { timezone: TZ }
  );
  cron.schedule(
    "0 7 * * *",
    async () => {
      console.log("[jw-sales] 7 AM daily sales report email starting");
      try { await runSalesEmail(yesterdayET()); } catch (e) { console.error("[jw-sales] failed:", e.message); }
    },
    { timezone: TZ }
  );
  console.log("[jw] nightly warehouse sync scheduled for 00:15 " + TZ);
  console.log("[jw] daily sales report email scheduled for 07:00 " + TZ);
}

// ---------------------------------------------------------------------------
// Daily Sales Report (HVAC Free Estimate appointments) + 7 AM email
// ---------------------------------------------------------------------------
const SALES_RECIPIENTS = "service@local-ac.com";

function yesterdayET() {
  const d = new Date(Date.now() - 86400000);
  return d.toLocaleString("en-CA", { timeZone: TZ }).slice(0, 10);
}
function parseAssigned(s) {
  if (!s) return [];
  try { return (JSON.parse(s) || []).map((u) => u && u.name).filter(Boolean); }
  catch { return []; }
}
function classifyOutcome(msg) {
  const t = (msg || "").toLowerCase();
  const lender = /aqua|foundation|chowder|microf|synchrony|financ/.test(t);
  const declined = /declin|denied|not approv|turned down|no approv/.test(t);
  if (declined && /aqua|foundation/.test(t) && /chowder|microf/.test(t)) return "Financing wall - not the rep's fault";
  if (declined && lender) return "Financing issue";
  if (/follow ?up|think|call back|callback|consider|2nd opinion|second opinion|get back|spouse|wife|husband/.test(t)) return "Still alive - follow up";
  if (/price|expensive|competitor|cheaper|shop|too high/.test(t)) return "Price / competition";
  if (/no ?show|not home|reschedul|cancel/.test(t)) return "No-show / reschedule";
  if (t.trim()) return "Other - see notes";
  return "No note yet";
}
function scrubPII(s) {
  if (!s) return "";
  return String(s)
    .replace(/\S+@\S+\.\S+/g, "[email]")
    .replace(/\+?\d[\d\s().\-]{7,}\d/g, "[phone]")
    .replace(/\b\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+\w+){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Ct|Court|Way|Cir|Circle|Pl|Place|Ter|Terrace|Hwy|Pkwy|Trail|Trl)\b\.?/gi, "[address]")
    .replace(/\b\d{3,}\b/g, "[#]")
    .replace(/\s+/g, " ")
    .trim();
}
function buildSalesReport(dateStr) {
  const jobs = db.prepare(
    `SELECT j.id, j.title, j.status, j.assigned_users, j.client_id, c.name AS client
     FROM jw_jobs j LEFT JOIN jw_clients c ON c.id = j.client_id
     WHERE j.title LIKE '%Free Estimate%' AND substr(j.start_at,1,10) = ?`
  ).all(dateStr);
  const invForClient = db.prepare(
    `SELECT total, created_at FROM jw_invoices WHERE client_id = ? AND substr(created_at,1,10) >= ? ORDER BY created_at DESC LIMIT 1`
  );
  const lastNote = db.prepare(
    `SELECT created_by_name, message FROM jw_notes WHERE object_type='job' AND object_id = ? ORDER BY created_at DESC LIMIT 1`
  );
  const rows = jobs.map((j) => {
    const reps = parseAssigned(j.assigned_users);
    const rep = reps[0] || "Unassigned";
    const phone = /\(ph\)/i.test(j.title || "");
    const inv = invForClient.get(j.client_id, dateStr);
    const sold = !!inv;
    const note = lastNote.get(j.id) || {};
    return { client: j.client || "(unknown)", rep, type: phone ? "Phone" : "Physical",
      sold, ticket: sold ? (inv.total || 0) : 0,
      outcome: sold ? "Sold" : classifyOutcome(note.message), noteBy: note.created_by_name || null,
      noteText: sold ? "" : scrubPII(note.message || "").slice(0, 240) };
  });
  const total = rows.length;
  const physical = rows.filter((r) => r.type === "Physical").length;
  const phone = total - physical;
  const sold = rows.filter((r) => r.sold).length;
  const revenue = rows.reduce((a, r) => a + (r.ticket || 0), 0);
  const byRep = {};
  for (const r of rows) {
    byRep[r.rep] = byRep[r.rep] || { rep: r.rep, jobs: 0, physical: 0, phone: 0, sold: 0 };
    byRep[r.rep].jobs++; byRep[r.rep][r.type === "Physical" ? "physical" : "phone"]++;
    if (r.sold) byRep[r.rep].sold++;
  }
  return { date: dateStr, total, physical, phone, sold,
    conversion: total ? Math.round((sold / total) * 100) : 0,
    revenue, avgTicket: sold ? Math.round(revenue / sold) : 0,
    byRep: Object.values(byRep), rows };
}
function renderSalesEmailHtml(r) {
  const money = (n) => "$" + (n || 0).toLocaleString("en-US");
  const repRows = r.byRep.map((x) =>
    `<tr><td>${x.rep}</td><td align="center">${x.jobs}</td><td align="center">${x.physical}</td><td align="center">${x.phone}</td><td align="center">${x.sold}</td><td align="center">${x.jobs ? Math.round((x.sold / x.jobs) * 100) : 0}%</td></tr>`).join("");
  const jobRows = r.rows.map((x) =>
    `<tr><td>${x.client}</td><td>${x.rep}</td><td>${x.type}</td><td>${x.sold ? "Sold" : x.outcome}</td><td align="right">${x.sold ? money(x.ticket) : "-"}</td><td>${x.noteBy ? "note by " + x.noteBy : ""}</td></tr>`).join("");
  const flags = [];
  r.byRep.forEach((x) => { if (x.jobs > 0 && x.sold === 0) flags.push(`${x.rep} went 0-for-${x.jobs}`); });
  const fw = r.rows.filter((x) => x.outcome && x.outcome.indexOf("Financing wall") >= 0).length;
  if (fw) flags.push(`${fw} lost to financing (not the rep's fault)`);
  const flagsHtml = flags.length ? `<p style="background:#fff7e6;border:1px solid #ffd591;padding:8px 12px;border-radius:4px"><b>Flags:</b> ${flags.join(" &middot; ")}</p>` : "";
  const notSold = r.rows.filter((x) => !x.sold);
  const whatHtml = notSold.length ? `<h3>What happened (not sold)</h3><ul>${notSold.map((x) => `<li><b>${x.client}</b> &middot; ${x.rep} &middot; <i>${x.outcome}</i>${x.noteText ? " &mdash; " + x.noteText : ""}</li>`).join("")}</ul>` : "";
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
  <h2 style="margin:0 0 4px">Local AC - Daily Sales Report</h2>
  <p style="color:#666;margin:0 0 12px">${r.date} &middot; HVAC Free Estimate appointments</p>
  <p><b>${r.total}</b> appointments (${r.physical} physical, ${r.phone} phone) &middot; <b>${r.sold} sold</b> &middot; conversion <b>${r.conversion}%</b> &middot; revenue <b>${money(r.revenue)}</b>${r.sold ? " &middot; avg ticket " + money(r.avgTicket) : ""}</p>
  ${flagsHtml}
  <h3>By rep</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
  <tr style="background:#f3f3f3"><th>Rep</th><th>Jobs</th><th>Physical</th><th>Phone</th><th>Sold</th><th>Conv.</th></tr>
  ${repRows || '<tr><td colspan="6">No appointments.</td></tr>'}
  </table>
  <h3>Appointments</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
  <tr style="background:#f3f3f3"><th>Customer</th><th>Rep</th><th>Type</th><th>Outcome</th><th>Ticket</th><th>Notes</th></tr>
  ${jobRows || '<tr><td colspan="6">No appointments.</td></tr>'}
  </table>
  ${whatHtml}
  <p style="color:#888;font-size:12px;margin-top:16px">From the Jobber warehouse. Not-sold outcome is classified from the rep's note. Sold = an invoice created for the customer on/after the appointment date.</p>
  </div>`;
}
export async function runSalesEmail(dateStr, { nomail = false } = {}) {
  const date = dateStr || yesterdayET();
  const r = buildSalesReport(date);
  const html = renderSalesEmailHtml(r);
  const label = new Date(date + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let sent = false;
  if (!nomail) { await sendMail({ to: SALES_RECIPIENTS, subject: `Local AC - Sales Report (${label})`, html }); sent = true; }
  return { date, sent, recipients: SALES_RECIPIENTS, summary: { total: r.total, sold: r.sold, conversion: r.conversion, revenue: r.revenue, byRep: r.byRep }, details: r.rows.map((x) => ({ client: x.client, rep: x.rep, type: x.type, sold: x.sold, outcome: x.outcome, note: x.noteText || "" })), htmlLen: html.length };
}

function lastWeekRange() {
  // Most recent complete Sunday..Saturday (relative to ET "today").
  const todayET = yesterdayET(); // YYYY-MM-DD for "yesterday"; good enough anchor
  const d = new Date(todayET + "T12:00:00Z");
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const sat = new Date(d); sat.setUTCDate(d.getUTCDate() - ((dow + 1) % 7)); // last Saturday on/before yesterday
  const sun = new Date(sat); sun.setUTCDate(sat.getUTCDate() - 6);
  const f = (x) => x.toISOString().slice(0, 10);
  return [f(sun), f(sat)];
}
function buildWeeklyReport(start, end) {
  const jobs = db.prepare(
    `SELECT j.id, j.title, j.assigned_users, j.client_id, c.name AS client, substr(j.start_at,1,10) AS d
     FROM jw_jobs j LEFT JOIN jw_clients c ON c.id = j.client_id
     WHERE j.title LIKE '%Free Estimate%' AND substr(j.start_at,1,10) BETWEEN ? AND ?`
  ).all(start, end);
  const invForClient = db.prepare(
    `SELECT total FROM jw_invoices WHERE client_id = ? AND substr(created_at,1,10) >= ? ORDER BY created_at DESC LIMIT 1`
  );
  const rows = jobs.map((j) => {
    const repList = parseAssigned(j.assigned_users);
    const rep = repList[0] || "Unassigned";
    const phone = /\(ph\)/i.test(j.title || "");
    const inv = invForClient.get(j.client_id, j.d);
    const sold = !!inv;
    return { date: j.d, client: j.client || "(unknown)", rep, type: phone ? "Phone" : "Physical", sold, ticket: sold ? (inv.total || 0) : 0 };
  });
  const agg = (arr) => {
    const total = arr.length, physical = arr.filter((r) => r.type === "Physical").length;
    const phone = total - physical, sold = arr.filter((r) => r.sold).length;
    const revenue = arr.reduce((a, r) => a + (r.ticket || 0), 0);
    return { total, physical, phone, sold, conversion: total ? Math.round((sold / total) * 100) : 0, revenue, avgTicket: sold ? Math.round(revenue / sold) : 0 };
  };
  const byRepMap = {}, byDayMap = {};
  for (const r of rows) { (byRepMap[r.rep] = byRepMap[r.rep] || []).push(r); (byDayMap[r.date] = byDayMap[r.date] || []).push(r); }
  const byRep = Object.keys(byRepMap).map((k) => ({ rep: k, ...agg(byRepMap[k]) }));
  const byDay = Object.keys(byDayMap).sort().map((d) => ({ date: d, ...agg(byDayMap[d]) }));
  return { start, end, ...agg(rows), byRep, byDay };
}
function renderWeeklyHtml(r, summary) {
  const money = (n) => "$" + (n || 0).toLocaleString("en-US");
  const dow = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const repRows = r.byRep.map((x) =>
    `<tr><td>${x.rep}</td><td align="center">${x.total}</td><td align="center">${x.physical}</td><td align="center">${x.phone}</td><td align="center">${x.sold}</td><td align="center">${x.total ? Math.round((x.sold / x.total) * 100) : 0}%</td><td align="right">${money(x.revenue)}</td></tr>`).join("");
  const dayRows = r.byDay.map((x) =>
    `<tr><td>${dow(x.date)}</td><td align="center">${x.total}</td><td align="center">${x.sold}</td><td align="center">${x.total ? Math.round((x.sold / x.total) * 100) : 0}%</td><td align="right">${money(x.revenue)}</td></tr>`).join("");
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
  <h2 style="margin:0 0 4px">Local AC - Weekly Sales Report</h2>
  <p style="color:#666;margin:0 0 12px">${dow(r.start)} &ndash; ${dow(r.end)} &middot; HVAC Free Estimate appointments</p>
  ${summary ? `<div style="background:#f0f7ff;border:1px solid #91caff;border-radius:6px;padding:12px 16px;margin:0 0 16px"><h3 style="margin:0 0 6px">The week in review</h3>${summary}</div>` : ""}
  <p><b>${r.total}</b> appointments (${r.physical} physical, ${r.phone} phone) &middot; <b>${r.sold} sold</b> &middot; conversion <b>${r.conversion}%</b> &middot; revenue <b>${money(r.revenue)}</b>${r.sold ? " &middot; avg ticket " + money(r.avgTicket) : ""}</p>
  <h3>By rep (week)</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
  <tr style="background:#f3f3f3"><th>Rep</th><th>Appts</th><th>Physical</th><th>Phone</th><th>Sold</th><th>Conv.</th><th>Revenue</th></tr>
  ${repRows || '<tr><td colspan="7">No appointments.</td></tr>'}
  </table>
  <h3>By day</h3>
  <table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse">
  <tr style="background:#f3f3f3"><th>Day</th><th>Appts</th><th>Sold</th><th>Conv.</th><th>Revenue</th></tr>
  ${dayRows || '<tr><td colspan="5">No appointments.</td></tr>'}
  </table>
  <p style="color:#888;font-size:12px;margin-top:16px">From the Jobber warehouse. Sold = an invoice created for the customer on/after the appointment date. Sold counts firm up after the nightly invoice sync.</p>
  </div>`;
}
export async function runWeeklyEmail(start, end, { nomail = false, summary = "" } = {}) {
  let s0 = start, e0 = end;
  if (!s0 || !e0) { const wr = lastWeekRange(); s0 = s0 || wr[0]; e0 = e0 || wr[1]; }
  const r = buildWeeklyReport(s0, e0);
  const html = renderWeeklyHtml(r, summary);
  const lbl = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  let sent = false;
  if (!nomail) { await sendMail({ to: SALES_RECIPIENTS, subject: `Local AC - Weekly Sales Report (${lbl(s0)} - ${lbl(e0)})`, html }); sent = true; }
  return { start: s0, end: e0, sent, recipients: SALES_RECIPIENTS, summary: { total: r.total, sold: r.sold, conversion: r.conversion, revenue: r.revenue, byRep: r.byRep }, htmlLen: html.length };
}

// ---------------------------------------------------------------------------
// Admin router (secret-gated; mounted from server.js BEFORE requireAuth)
// ---------------------------------------------------------------------------
export function buildJobberWarehouseRouter() {
  const router = express.Router();

  router.get("/admin/jobber/wh/status/" + SECRET, (req, res) => {
    res.json({ ok: true, ...warehouseStatus() });
  });

  router.get("/admin/jobber/wh/sync/" + SECRET, (req, res) => {
    const wait = req.query.wait === "1";
    const only = req.query.only || null;
    if (req.query.first) {
      const f = parseInt(req.query.first, 10);
      if (Number.isFinite(f) && f >= 1 && f <= 200) PAGE_SIZE = f;
    }
    if (wait) {
      runFullSync({ only })
        .then((r) => res.json({ ok: true, ...r }))
        .catch((e) => res.status(500).json({ ok: false, error: e.message }));
    } else {
      runFullSync({ only }).catch((e) => console.error("[jw] background sync error:", e.message));
      res.json({ ok: true, started: true, note: "Sync running in background. Poll /admin/jobber/wh/status/<secret>." });
    }
  });

  // Read-only SQL over the warehouse (secret-gated). SELECT only; base64url in ?sql_b64=.
  router.get("/admin/jobber/wh/query/" + SECRET, (req, res) => {
    let sql = "";
    try {
      const b64 = String(req.query.sql_b64 || "");
      sql = Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      return res.status(400).json({ ok: false, error: "bad sql_b64" });
    }
    if (
      !/^\s*select\s/i.test(sql) || sql.includes(";") ||
      /\b(insert|update|delete|drop|alter|attach|pragma|create|replace|vacuum)\b/i.test(sql)
    ) {
      return res.status(400).json({ ok: false, error: "Only a single read-only SELECT is allowed." });
    }
    try {
      const rows = db.prepare(sql).all();
      res.json({ ok: true, sql, rowCount: rows.length, rows });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Phase B: download 2026+ attachment files to disk (background). ?sinceYear= optional.
  router.get("/admin/jobber/wh/download/" + SECRET, (req, res) => {
    const sinceYear = req.query.sinceYear ? parseInt(req.query.sinceYear, 10) : 2026;
    const wait = req.query.wait === "1";
    if (wait) {
      downloadAttachments({ sinceYear })
        .then((r) => res.json({ ok: true, ...r }))
        .catch((e) => res.status(500).json({ ok: false, error: e.message }));
    } else {
      downloadAttachments({ sinceYear }).catch((e) => console.error("[jw-dl] background error:", e.message));
      res.json({ ok: true, started: true, sinceYear, note: "Downloading in background. Poll /admin/jobber/wh/status/<secret> for downloadedFiles/downloadedGB." });
    }
  });

  // Read-only GraphQL probe for schema discovery. ?q_b64=<base64url read query>. Mutations blocked.
  router.get("/admin/jobber/wh/probe-job/" + SECRET, async (req, res) => {
    try {
      let q = `query { jobs(first: 1) { nodes { id title } } }`;
      if (req.query.q_b64) {
        q = Buffer.from(String(req.query.q_b64).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
      }
      if (/\b(mutation|subscription)\b/i.test(q)) {
        return res.status(400).json({ ok: false, error: "Only read queries allowed." });
      }
      const data = await gqlThrottleAware(q);
      res.json({ ok: true, data });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  // Daily sales report email: build from warehouse + send via mailer. ?date=YYYY-MM-DD&nomail=1
  router.get("/admin/jobber/wh/sales-email/" + SECRET, async (req, res) => {
    try {
      const r = await runSalesEmail(req.query.date || null, { nomail: req.query.nomail === "1" });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Weekly sales report email (Sun-Sat). ?start=YYYY-MM-DD&end=YYYY-MM-DD&nomail=1 (defaults to last complete week)
  router.get("/admin/jobber/wh/sales-weekly/" + SECRET, async (req, res) => {
    try {
      const r = await runWeeklyEmail(req.query.start || null, req.query.end || null, { nomail: req.query.nomail === "1", summary: req.query.summary || "" });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // Send a fully-composed report (HTML built by the agent). POST JSON {subject, html}. Recipient fixed.
  router.post("/admin/jobber/wh/send-report/" + SECRET, (req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 2000000) req.destroy(); });
    req.on("end", async () => {
      try {
        const body = JSON.parse(raw || "{}");
        if (!body.html) return res.status(400).json({ ok: false, error: "html required" });
        const recips = Array.isArray(body.to) && body.to.length ? body.to : SALES_RECIPIENTS;
        await sendMail({ to: recips, subject: body.subject || "Local AC - Sales Report", html: body.html });
        res.json({ ok: true, sent: true, to: recips, htmlLen: body.html.length });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    });
  });
  return router;
}
