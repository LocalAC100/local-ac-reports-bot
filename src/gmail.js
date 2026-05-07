// Gmail watcher for supplier invoices.
//
// Watches office@local-ac.com (a Google Workspace inbox) for messages from:
//   - Gemaire, Goodman, Home Depot
// For each new message, downloads attached PDFs, attempts to parse line
// items into Equipment vs Materials, and either:
//   (a) applies the cost to a matching gp_jobs row (Part 3 of the spec), or
//   (b) files it under Unmatched Invoices, or
//   (c) files it under Inventory if it's clearly not for a single job.
//
// Auth: same Google service account as src/sheets.js, with domain-wide
// delegation to impersonate office@local-ac.com.
// Required env vars:
//   GOOGLE_SA_JSON or /etc/secrets/google-sa.json
//   GMAIL_DELEGATED_USER  (e.g. "office@local-ac.com")
//
// Idempotency: a gp_processed_emails table records message IDs we've seen.

import fs from "fs";
import { db } from "./db.js";
import {
  GpJobs,
  GpAttachments,
  GpUnmatched,
  GpInventory,
  normalizeName,
} from "./gross-profit.js";

// ---------- Schema for processed-message tracking ----------
db.exec(`
CREATE TABLE IF NOT EXISTS gp_processed_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT UNIQUE NOT NULL,
  thread_id TEXT,
  from_addr TEXT,
  subject TEXT,
  received_at TEXT,
  outcome TEXT,                 -- 'matched' | 'unmatched' | 'inventory' | 'skipped' | 'error'
  job_id INTEGER,
  unmatched_id INTEGER,
  inventory_id INTEGER,
  attachment_id INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_gp_processed_msg ON gp_processed_emails(message_id);
`);

// ---------- Configuration ----------
export function isConfigured() {
  if (!process.env.GMAIL_DELEGATED_USER) return false;
  if (process.env.GOOGLE_SA_JSON) return true;
  if (fs.existsSync("/etc/secrets/google-sa.json")) return true;
  return false;
}

export function status() {
  const seen = db.prepare("SELECT COUNT(*) AS n FROM gp_processed_emails").get().n;
  const lastRow = db
    .prepare("SELECT MAX(created_at) AS t FROM gp_processed_emails")
    .get();
  return {
    serviceAccount: Boolean(process.env.GOOGLE_SA_JSON || fs.existsSync("/etc/secrets/google-sa.json")),
    delegatedUser: process.env.GMAIL_DELEGATED_USER || null,
    processedCount: seen,
    lastProcessed: lastRow?.t || null,
  };
}

// ---------- Google client ----------
const cachedClients = new Map(); // user email -> gmail client
function getDelegatedUsers() {
  const multi = process.env.GMAIL_DELEGATED_USERS;
  const single = process.env.GMAIL_DELEGATED_USER;
  const raw = multi || single || "";
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

async function getGmailClient(userEmail) {
  if (!userEmail) throw new Error("userEmail required");
  if (cachedClients.has(userEmail)) return cachedClients.get(userEmail);
  let creds;
  if (process.env.GOOGLE_SA_JSON) creds = JSON.parse(process.env.GOOGLE_SA_JSON);
  else if (fs.existsSync("/etc/secrets/google-sa.json"))
    creds = JSON.parse(fs.readFileSync("/etc/secrets/google-sa.json", "utf8"));
  else throw new Error("Google service account not configured");
  if (getDelegatedUsers().length === 0) {
    throw new Error("GMAIL_DELEGATED_USERS or GMAIL_DELEGATED_USER env var required");
  }
  const { google } = await import("googleapis");
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    subject: userEmail,
  });
  await auth.authorize();
  const client = google.gmail({ version: "v1", auth });
  cachedClients.set(userEmail, client);
  return client;
}

// ---------- Supplier identification ----------
const SUPPLIERS = [
  { key: "gemaire",    domains: ["gemaire.com"],          subjectHints: ["gemaire"] },
  { key: "goodman",    domains: ["goodmanmfg.com", "goodmandistribution.com"], subjectHints: ["goodman"] },
  { key: "home_depot", domains: ["homedepot.com"],        subjectHints: ["home depot", "homedepot"] },
];

function identifySupplier({ from, subject }) {
  const fromLower = (from || "").toLowerCase();
  const subjLower = (subject || "").toLowerCase();
  for (const s of SUPPLIERS) {
    if (s.domains.some((d) => fromLower.includes(d))) return s.key;
    if (s.subjectHints.some((h) => subjLower.includes(h))) return s.key;
  }
  return null;
}

// ---------- PDF text extraction ----------
//
// We try pdf-parse if installed; otherwise we treat the PDF as opaque
// and file it as unmatched (with the bytes attached) for manual review.
async function extractPdfText(bytes) {
  try {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const result = await mod.default(bytes);
    return result.text || "";
  } catch (e) {
    return null;
  }
}

// ---------- Equipment vs Materials classifier ----------
//
// Heuristic: keyword match per line. Tunable. Spec says:
//   Equipment = HVAC units, condensers, air handlers, coils, etc.
//   Materials = everything else (fittings, copper, wire, pad, etc.)
const EQUIPMENT_KEYWORDS = [
  "condenser", "air handler", "ahu", "package unit", "heat pump",
  "furnace", "evaporator coil", "coil", "split system", "compressor",
  "thermostat", "ac unit", "outdoor unit", "indoor unit", "mini split",
];

function classifyLine(text) {
  const t = (text || "").toLowerCase();
  return EQUIPMENT_KEYWORDS.some((k) => t.includes(k)) ? "equipment" : "materials";
}

function parseInvoiceText(text) {
  // Try to extract: PO/customer name, line items, total.
  // Suppliers vary wildly; this is a best-effort first pass.
  const lines = (text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let poName = null;
  for (const line of lines) {
    const m = line.match(/\b(P\.?O\.?|Job|Customer|Reference|Bill\s*To)[:#\s]+([^\n]+)/i);
    if (m) { poName = m[2].trim().split(/\s{2,}/)[0]; break; }
  }
  // Line items: rows that contain a quantity, a description, and a price.
  // Match any line with "$NN.NN" (or "NN.NN") at the end.
  let equipment = 0, materials = 0;
  for (const line of lines) {
    const m = line.match(/^(.*\S)\s+\$?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)$/);
    if (!m) continue;
    const desc = m[1];
    const amount = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(amount)) continue;
    if (classifyLine(desc) === "equipment") equipment += amount;
    else materials += amount;
  }
  // Total: look for "Total" or "Amount Due" with a $X.XX
  let total = null;
  for (const line of lines.reverse()) {
    const m = line.match(/(?:total|amount due|grand total)[\s:]*\$?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)/i);
    if (m) { total = parseFloat(m[1].replace(/,/g, "")); break; }
  }
  return { poName, equipment, materials, total };
}

// ---------- Run once ----------
//
// Pulls newest 50 unprocessed messages from any supplier. Idempotent.
export async function pollOnce({ window = 50 } = {}) {
  if (!isConfigured()) {
    return { skipped: true, reason: "Gmail watcher not configured" };
  }
  const users = getDelegatedUsers();
  if (!users.length) return { skipped: true, reason: "no Gmail mailboxes configured" };
  const totals = { matched: 0, unmatched: 0, errors: 0, processed: 0, perUser: {} };
  for (const userEmail of users) {
    let gmail;
    try {
      gmail = await getGmailClient(userEmail);
    } catch (e) {
      totals.errors++;
      totals.perUser[userEmail] = { error: e.message };
      continue;
    }
    const userResult = await pollOnceForUser(gmail);
    totals.matched += userResult.matched || 0;
    totals.unmatched += userResult.unmatched || 0;
    totals.errors += userResult.errors || 0;
    totals.processed += userResult.processed || 0;
    totals.perUser[userEmail] = userResult;
  }
  return totals;
}

async function pollOnceForUser(gmail) {
  let _placeholder;
  try { _placeholder = null; } catch (e) {}

  // Build a Gmail search query: from any supplier, has attachment, newer_than:30d
  const fromClause = SUPPLIERS.map((s) => s.domains.map((d) => `from:${d}`).join(" OR ")).map((c) => `(${c})`).join(" OR ");
  const q = `(${fromClause}) has:attachment newer_than:30d`;

  const list = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: window,
  });
  const messages = list.data.messages || [];

  let processed = 0, matched = 0, unmatched = 0, inventory = 0, errors = 0;
  for (const m of messages) {
    if (db.prepare("SELECT 1 AS x FROM gp_processed_emails WHERE message_id = ?").get(m.id)) continue;
    try {
      await processMessage(gmail, m.id);
      processed++;
    } catch (e) {
      errors++;
      console.warn(`[gmail] processing ${m.id} failed:`, e.message);
      db.prepare(
        `INSERT OR IGNORE INTO gp_processed_emails (message_id, outcome, notes) VALUES (?, 'error', ?)`
      ).run(m.id, e.message);
    }
  }
  return { scanned: messages.length, processed };
}

async function processMessage(gmail, messageId) {
  const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
  const headers = Object.fromEntries(
    (full.data.payload?.headers || []).map((h) => [h.name.toLowerCase(), h.value])
  );
  const fromAddr = headers["from"] || "";
  const subject  = headers["subject"] || "";
  const date     = headers["date"] || full.data.internalDate;

  const supplier = identifySupplier({ from: fromAddr, subject });
  if (!supplier) {
    db.prepare(
      `INSERT INTO gp_processed_emails (message_id, thread_id, from_addr, subject, received_at, outcome, notes)
       VALUES (?, ?, ?, ?, ?, 'skipped', 'unknown supplier')`
    ).run(messageId, full.data.threadId, fromAddr, subject, date);
    return;
  }

  // Find PDF attachments
  const parts = collectParts(full.data.payload);
  const pdfParts = parts.filter((p) =>
    (p.mimeType || "").includes("pdf") ||
    /\.pdf$/i.test(p.filename || "")
  );
  if (pdfParts.length === 0) {
    db.prepare(
      `INSERT INTO gp_processed_emails (message_id, thread_id, from_addr, subject, received_at, outcome, notes)
       VALUES (?, ?, ?, ?, ?, 'skipped', 'no PDF attachment')`
    ).run(messageId, full.data.threadId, fromAddr, subject, date);
    return;
  }

  // For each PDF, save bytes + parse + match
  for (const part of pdfParts) {
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: part.body.attachmentId,
    });
    const bytes = Buffer.from(att.data.data, "base64url");
    const text = await extractPdfText(bytes);
    const parsed = text ? parseInvoiceText(text) : { poName: null, equipment: 0, materials: 0, total: null };

    // Try to match the PO name to a customer
    let jobId = null;
    let candList = [];
    if (parsed.poName) {
      candList = GpJobs.findCandidatesByCustomer(parsed.poName, { windowDays: 30, minSimilarity: 0.7 });
      // Auto-accept only if top candidate is high-confidence and not ambiguous
      if (candList.length && candList[0].sim >= 0.9 &&
          (candList.length < 2 || candList[0].sim - candList[1].sim >= 0.1)) {
        jobId = candList[0].row.id;
      }
    }

    const attachmentId = GpAttachments.save({
      jobId,
      source: "supplier_invoice",
      supplier,
      filename: part.filename || `${supplier}-${messageId}.pdf`,
      mimeType: "application/pdf",
      bytes,
      metadata: { parsed, candList: candList.slice(0, 3).map(c => ({ id: c.row.id, name: c.row.customer_name, sim: c.sim })) },
    });

    if (jobId) {
      GpJobs.applySupplierInvoice(jobId, {
        equipmentCost: parsed.equipment,
        materialsCost: parsed.materials,
        totalWithTax: parsed.total,
      });
      db.prepare(
        `INSERT INTO gp_processed_emails (message_id, thread_id, from_addr, subject, received_at, outcome, job_id, attachment_id)
         VALUES (?, ?, ?, ?, ?, 'matched', ?, ?)`
      ).run(messageId, full.data.threadId, fromAddr, subject, date, jobId, attachmentId);
    } else {
      const unmId = GpUnmatched.add({
        supplier,
        poName: parsed.poName,
        totalAmount: parsed.total,
        attachmentId,
        notes: text == null ? "PDF could not be parsed" : null,
      });
      db.prepare(
        `INSERT INTO gp_processed_emails (message_id, thread_id, from_addr, subject, received_at, outcome, unmatched_id, attachment_id, notes)
         VALUES (?, ?, ?, ?, ?, 'unmatched', ?, ?, ?)`
      ).run(messageId, full.data.threadId, fromAddr, subject, date, unmId, attachmentId, text == null ? "no parse" : null);
    }
  }
}

function collectParts(payload, acc = []) {
  if (!payload) return acc;
  if (payload.parts) payload.parts.forEach((p) => collectParts(p, acc));
  else acc.push(payload);
  return acc;
}
