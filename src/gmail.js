// Gmail watcher for supplier invoices.
//
// Watches office@local-ac.com and service@local-ac.com (Workspace inboxes)
// for messages from:
//   - Gemaire, Goodman, Home Depot
// For each new message, downloads attached PDFs, attempts to parse line
// items into Equipment vs Materials, and either:
//   (a) applies the cost to a matching gp_jobs row (Part 3 of the spec), or
//   (b) files it under Unmatched Invoices, or
//   (c) files it under Inventory if it's clearly not for a single job.
//
// Auth: same Google service account as src/sheets.js, with domain-wide
// delegation to impersonate the configured mailboxes.
// Required env vars:
//   GOOGLE_SA_JSON or /etc/secrets/google-sa.json
//   GMAIL_DELEGATED_USERS  (comma-separated, e.g. "office@local-ac.com,service@local-ac.com")
//   GMAIL_DELEGATED_USER   (legacy single-user fallback)
//
// DEDUP: three layers of protection against double-counting an invoice:
//   1. gp_processed_emails(message_id UNIQUE) â message-level skip
//   2. gp_attachments.pdf_sha256 UNIQUE â same PDF bytes only stored once
//   3. gp_attachments.applied_at â applySupplierInvoice no-op if already set
// All three must be wrong simultaneously for a duplicate to slip through.
// Per-supplier subject filters also drop non-invoice mail (statements,
// payment receipts, monthly reports, cashback notices, etc.) before the
// PDF parser sees them.

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
function getDelegatedUsers() {
  // Prefer GMAIL_DELEGATED_USERS (comma-separated) for multi-mailbox polling.
  // Fall back to legacy GMAIL_DELEGATED_USER (single mailbox).
  const plural = (process.env.GMAIL_DELEGATED_USERS || "").trim();
  if (plural) {
    return plural.split(",").map((s) => s.trim()).filter(Boolean);
  }
  const singular = (process.env.GMAIL_DELEGATED_USER || "").trim();
  return singular ? [singular] : [];
}

export function isConfigured() {
  if (getDelegatedUsers().length === 0) return false;
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
    delegatedUsers: getDelegatedUsers(),
    processedCount: seen,
    lastProcessed: lastRow?.t || null,
  };
}

// ---------- Google client (one auth/client per delegated user) ----------
const cachedClients = new Map(); // userEmail -> gmail client
async function getGmailClient(userEmail) {
  if (cachedClients.has(userEmail)) return cachedClients.get(userEmail);
  let creds;
  if (process.env.GOOGLE_SA_JSON) creds = JSON.parse(process.env.GOOGLE_SA_JSON);
  else if (fs.existsSync("/etc/secrets/google-sa.json"))
    creds = JSON.parse(fs.readFileSync("/etc/secrets/google-sa.json", "utf8"));
  else throw new Error("Google service account not configured");
  if (!userEmail) throw new Error("getGmailClient: userEmail required");
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
//
// Per-supplier subject rules (filters applied AFTER the from/subject match):
//
//   Gemaire   â invoice mail arrives ~1 day after equipment pickup. Skip
//               payment confirmations, statements, and monthly reports.
//   Goodman   â same-day or next-day after pickup. Skip cashback/rewards
//               notifications, monthly reports, and payment confirmations.
//   Home Depot â order/receipt emails (paid at order time). Skip shipping
//               updates, returns, and promotional mail.
//
// `mustInclude` (if set) requires at least one of these tokens in the subject;
// `excludeAny` drops the message if any of these tokens appears.
const SUPPLIERS = [
  {
    // Gemaire actually sends "Sales Order Confirmation" emails (with the
    // invoice attached as PDF), not subjects with "Invoice" in them.
    key: "gemaire",
    domains: ["gemaire.com", "versapay.com"],
    subjectHints: ["gemaire"],
    mustInclude: ["invoice", "sales order", "order confirmation", "order #", "order#"],
    excludeAny: [
      "payment", "statement", "monthly", "report", "remittance",
      "confirmation of payment", "credit memo", "promotion",
    ],
  },
  {
    // Goodman = Daikin (Daikin acquired Goodman; invoices may come from
    // either brand's domains). Goodman invoices arrive as "Delivery Receipt/BOL
    // for Order HMxxxx & PO CUSTOMER NAME" â that's their invoice email format.
    key: "goodman",
    domains: [
      "goodmanmfg.com",
      "goodmandistribution.com",
      "daikin.com",
      "daikinapplied.com",
      "daikinac.com",
      "daikincomfort.com",
      "daikinhvac.com",
    ],
    subjectHints: ["goodman", "daikin"],
    mustInclude: [
      "invoice", "delivery receipt", "bol", "order",
    ],
    excludeAny: [
      "report", "statement", "monthly", "cashback", "rewards",
      "payment received", "remittance", "credit memo", "promotion",
    ],
  },
  {
    key: "home_depot",
    domains: ["homedepot.com", "orders.homedepot.com"],
    subjectHints: ["home depot", "homedepot"],
    mustInclude: ["order", "receipt", "purchase"],
    excludeAny: [
      "shipping", "shipped", "delivery", "return", "refund",
      "monthly", "statement", "promotion", "deal", "savings",
    ],
  },
];

function identifySupplier({ from, subject }) {
  const fromLower = (from || "").toLowerCase();
  const subjLower = (subject || "").toLowerCase();
  for (const s of SUPPLIERS) {
    if (s.domains.some((d) => fromLower.includes(d))) return s;
    if (s.subjectHints.some((h) => subjLower.includes(h))) return s;
  }
  return null;
}

// Returns null if the subject passes the supplier's filter; otherwise a
// string reason describing why the message was skipped.
function subjectSkipReason(supplier, subject) {
  const subj = (subject || "").toLowerCase();
  if (Array.isArray(supplier.excludeAny)) {
    const hit = supplier.excludeAny.find((tok) => subj.includes(tok));
    if (hit) return `excluded:${hit}`;
  }
  if (Array.isArray(supplier.mustInclude) && supplier.mustInclude.length) {
    const ok = supplier.mustInclude.some((tok) => subj.includes(tok));
    if (!ok) return `missing_required:${supplier.mustInclude.join("|")}`;
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
// Pulls unprocessed messages from each delegated mailbox.
// Idempotent at three levels (see DEDUP note in the file header).
//
// `since` (Gmail-format date YYYY/MM/DD or "newer_than:Nd") controls how far
// back to look. Default is "2026/01/01" â we backfill all of 2026 because
// gp_jobs only goes back that far. Pages through results so the maxResults
// cap doesn't truncate the backfill.
export async function pollOnce({ since = "2026/01/01", maxPages = 20 } = {}) {
  if (!isConfigured()) {
    return { skipped: true, reason: "Gmail watcher not configured" };
  }
  const users = getDelegatedUsers();
  const perUser = [];
  let totalScanned = 0, totalProcessed = 0, totalErrors = 0;
  for (const userEmail of users) {
    let gmail;
    try {
      gmail = await getGmailClient(userEmail);
    } catch (e) {
      perUser.push({ user: userEmail, error: e.message });
      totalErrors++;
      continue;
    }
    try {
      const r = await pollOnceForUser(gmail, userEmail, { since, maxPages });
      perUser.push({ user: userEmail, ...r });
      totalScanned += r.scanned || 0;
      totalProcessed += r.processed || 0;
      totalErrors += r.errors || 0;
    } catch (e) {
      perUser.push({ user: userEmail, error: e.message });
      totalErrors++;
    }
  }
  return { users: perUser, scanned: totalScanned, processed: totalProcessed, errors: totalErrors };
}

async function pollOnceForUser(gmail, userEmail, { since = "2026/01/01", maxPages = 20 } = {}) {
  // Build a Gmail search query: from any supplier, has attachment, after:<since>.
  // Gmail accepts YYYY/MM/DD dates after `after:` and natural relative tokens
  // like `newer_than:Nd`. We pass `since` straight in.
  const fromClause = SUPPLIERS.map((s) => s.domains.map((d) => `from:${d}`).join(" OR ")).map((c) => `(${c})`).join(" OR ");
  const dateClause = /^\d{4}\/\d{1,2}\/\d{1,2}$/.test(since)
    ? `after:${since}`
    : `newer_than:${since}`;
  const q = `(${fromClause}) has:attachment ${dateClause}`;

  // Page through results â Gmail caps at 500 per page.
  const messages = [];
  let pageToken = undefined;
  for (let page = 0; page < maxPages; page++) {
    const list = await gmail.users.messages.list({
      userId: "me",
      q,
      maxResults: 500,
      ...(pageToken ? { pageToken } : {}),
    });
    if (Array.isArray(list.data.messages)) messages.push(...list.data.messages);
    pageToken = list.data.nextPageToken;
    if (!pageToken) break;
  }

  let processed = 0, errors = 0;
  for (const m of messages) {
    // First dedup gate: have we already seen this Gmail message ID?
    if (db.prepare("SELECT 1 AS x FROM gp_processed_emails WHERE message_id = ?").get(m.id)) continue;
    try {
      await processMessage(gmail, m.id, userEmail);
      processed++;
    } catch (e) {
      errors++;
      console.warn(`[gmail][${userEmail}] processing ${m.id} failed:`, e.message);
      db.prepare(
        `INSERT OR IGNORE INTO gp_processed_emails (message_id, outcome, notes) VALUES (?, 'error', ?)`
      ).run(m.id, e.message);
    }
  }
  return { scanned: messages.length, processed, errors };
}

async function processMessage(gmail, messageId, userEmail) {
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
       VALUES (?, ?, ?, ?, ?, 'skipped', ?)`
    ).run(messageId, full.data.threadId, fromAddr, subject, date, `unknown supplier (mbox=${userEmail})`);
    return;
  }

  // Subject-level filter: skip non-invoice mail (statements, payment confirms,
  // monthly reports, cashback, etc.). This is the "skip and flag" pass per spec.
  const skip = subjectSkipReason(supplier, subject);
  if (skip) {
    db.prepare(
      `INSERT INTO gp_processed_emails (message_id, thread_id, from_addr, subject, received_at, outcome, notes)
       VALUES (?, ?, ?, ?, ?, 'skipped', ?)`
    ).run(messageId, full.data.threadId, fromAddr, subject, date, `${supplier.key}:${skip}`);
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

  // For each PDF, save bytes + parse + match. Track per-message outcomes so
  // we can stamp ONE gp_processed_emails row at the end (UNIQUE on message_id).
  const outcomes = [];
  for (const part of pdfParts) {
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: part.body.attachmentId,
    });
    const bytes = Buffer.from(att.data.data, "base64url");
    const text = await extractPdfText(bytes);
    const parsed = text ? parseInvoiceText(text) : { poName: null, equipment: 0, materials: 0, total: null };

    // Subject-based PO-name fallback: Goodman ("PO CUSTOMER NAME") and Gemaire
    // emails put the PO/customer right in the subject line. If the PDF parser
    // didn't find a poName, recover it from the subject.
    if (!parsed.poName && supplier && (supplier.key === "goodman" || supplier.key === "gemaire")) {
      const m = String(subject || "").match(/\bPO\s+([A-Z][A-Z'\.\- ]{2,})$/i)
             || String(subject || "").match(/\bPO\s+([A-Z][A-Z'\.\- ]+)\s*&/i);
      if (m) parsed.poName = m[1].trim();
    }

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

    // GpAttachments.save now returns { id, deduped, alreadyApplied } â
    // dedup happens via SHA-256 on the PDF bytes, so the same PDF re-attached
    // to a different email will resolve to the existing attachment row.
    const saveRes = GpAttachments.save({
      jobId,
      source: "supplier_invoice",
      supplier: supplier.key,
      filename: part.filename || `${supplier.key}-${messageId}.pdf`,
      mimeType: "application/pdf",
      bytes,
      metadata: { parsed, candList: candList.slice(0, 3).map(c => ({ id: c.row.id, name: c.row.customer_name, sim: c.sim })), mailbox: userEmail },
      gmailMessageId: messageId,
      gmailAttachmentPartId: part.body.attachmentId,
    });
    const attachmentId = saveRes.id;

    if (jobId) {
      // applySupplierInvoice is a no-op if attachment.applied_at is already
      // set â that's our final gate against double-counting costs.
      const applyRes = GpJobs.applySupplierInvoice(jobId, {
        equipmentCost: parsed.equipment,
        materialsCost: parsed.materials,
        totalWithTax: parsed.total,
      }, { attachmentId });
      outcomes.push({
        outcome: applyRes.applied ? "matched" : "duplicate",
        jobId,
        attachmentId,
        notes: applyRes.applied ? null : `dedup: ${applyRes.reason || "already_applied"}`,
      });
    } else {
      // Unmatched path: only file a new unmatched row if this is a new attachment.
      // (If we already saw this PDF, we already filed it â don't duplicate.)
      let unmId = null;
      if (!saveRes.deduped) {
        unmId = GpUnmatched.add({
          supplier: supplier.key,
          poName: parsed.poName,
          totalAmount: parsed.total,
          attachmentId,
          notes: text == null ? "PDF could not be parsed" : null,
        });
      }
      outcomes.push({
        outcome: saveRes.deduped ? "duplicate" : "unmatched",
        unmatchedId: unmId,
        attachmentId,
        notes: saveRes.deduped ? "dedup: same PDF already filed" : (text == null ? "no parse" : null),
      });
    }
  }

  // Stamp ONE gp_processed_emails row for the message. If multiple PDFs led
  // to different outcomes, prefer 'matched' > 'unmatched' > 'duplicate' > 'skipped'.
  const priority = { matched: 4, unmatched: 3, duplicate: 2, skipped: 1 };
  outcomes.sort((a, b) => (priority[b.outcome] || 0) - (priority[a.outcome] || 0));
  const top = outcomes[0] || { outcome: "skipped", notes: "no outcomes" };
  const noteParts = outcomes
    .map((o, i) => `pdf${i + 1}=${o.outcome}${o.notes ? `(${o.notes})` : ""}`)
    .join("; ");
  db.prepare(
    `INSERT OR IGNORE INTO gp_processed_emails
       (message_id, thread_id, from_addr, subject, received_at, outcome, job_id, unmatched_id, attachment_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    messageId, full.data.threadId, fromAddr, subject, date,
    top.outcome, top.jobId || null, top.unmatchedId || null, top.attachmentId || null,
    noteParts
  );
}

function collectParts(payload, acc = []) {
  if (!payload) return acc;
  if (payload.parts) payload.parts.forEach((p) => collectParts(p, acc));
  else acc.push(payload);
  return acc;
}
