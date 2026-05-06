// Gross Profit module.
//
// One row per HVAC job. Data accumulates from three sources:
//   1. Jobber invoice  (creates the row, anchors customer + amount paid)
//   2. Chris's Google Sheet (labor, commissions, permits, other expenses)
//   3. Supplier invoice emails ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ Gemaire, Goodman, Home Depot (equipment + materials)
// Once enough data is in place, GP $ and GP % are computed.
//
// The DB is the source of truth. A separate mirror writer (src/sheets.js)
// can push the same rows into a shared Google Sheet for easy export.
//
// Important: this module does NOT make outbound calls. Connector modules
// (jobber-sync.js, sheets.js, gmail.js) call into this module's helpers
// once they've gathered data from their source.

import fs from "fs";
import path from "path";
import { db } from "./db.js";

// ---------- Storage path for PDF attachments ----------
function pickAttachmentDir() {
  const candidates = [
    process.env.GP_ATTACHMENT_DIR,
    process.env.RENDER ? "/var/data/gp-attachments" : null,
    path.resolve("./data/gp-attachments"),
    "/tmp/gp-attachments",
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_) {}
  }
  throw new Error("[gross-profit] No writable attachment dir found");
}
const ATTACHMENT_DIR = pickAttachmentDir();
console.log(`[gross-profit] attachments at ${ATTACHMENT_DIR}`);

// ---------- Schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS gp_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Part 1: Jobber invoice
  jobber_invoice_id TEXT UNIQUE,
  jobber_invoice_number TEXT,
  jobber_client_id TEXT,
  jobber_invoice_issued_at TEXT,
  customer_name TEXT,
  address TEXT,
  city TEXT,
  zip TEXT,
  amount_paid REAL,
  payment_method TEXT,
  fee_amount REAL,
  fee_type TEXT,
  jobber_synced_at TEXT,

  -- Part 2: Chris's Google Sheet
  sheet_matched_at TEXT,
  sheet_row_ref TEXT,
  salesperson_name TEXT,
  sales_commission_amount REAL,
  sales_commission_rate REAL,
  sales_manager_name TEXT,
  sales_manager_fee REAL,
  permit_required INTEGER,
  permit_fee REAL,

  -- Part 3: Supplier invoices
  equipment_cost REAL,
  materials_cost REAL,
  equipment_materials_total REAL,
  supplier_invoices_synced_at TEXT,

  -- Part 4: Computed
  total_labor_cost REAL,
  total_other_expenses REAL,
  gross_profit_dollars REAL,
  gross_profit_percent REAL,

  -- Mirror-to-Sheet bookkeeping
  mirror_row_index INTEGER,
  mirror_synced_at TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gp_line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES gp_jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- 'invoice_item' | 'product_sold' | 'labor' | 'other_expense'
  position INTEGER,
  description TEXT,
  labor_name TEXT,
  labor_type TEXT,               -- 'sub' | 'employee'
  amount REAL,
  source TEXT,                   -- 'jobber' | 'sheet' | 'manual'
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gp_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER REFERENCES gp_jobs(id) ON DELETE CASCADE,
  source TEXT NOT NULL,          -- 'jobber_invoice' | 'supplier_invoice'
  supplier TEXT,                 -- 'gemaire' | 'goodman' | 'home_depot' | null
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  storage_path TEXT NOT NULL,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gp_unmatched_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT NOT NULL,
  po_name TEXT,
  total_amount REAL,
  attachment_id INTEGER REFERENCES gp_attachments(id),
  resolved_to_job_id INTEGER REFERENCES gp_jobs(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS gp_inventory_invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT NOT NULL,
  total_amount REAL,
  attachment_id INTEGER REFERENCES gp_attachments(id),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gp_jobs_customer ON gp_jobs(customer_name);
CREATE INDEX IF NOT EXISTS idx_gp_jobs_invoice ON gp_jobs(jobber_invoice_id);
CREATE INDEX IF NOT EXISTS idx_gp_jobs_issued ON gp_jobs(jobber_invoice_issued_at);
CREATE INDEX IF NOT EXISTS idx_gp_line_items_job ON gp_line_items(job_id);
CREATE INDEX IF NOT EXISTS idx_gp_attachments_job ON gp_attachments(job_id);
CREATE INDEX IF NOT EXISTS idx_gp_unmatched_supplier ON gp_unmatched_invoices(supplier);
`);

// ---------- Fuzzy customer-name matching ----------
//
// Suppliers and Chris use slightly different spellings of customer names.
// Normalize aggressively, then accept a Levenshtein distance up to ~15% of length.
// For matches below the threshold but above an even tighter floor, the caller
// can prompt the user to confirm.

export function normalizeName(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\b(mr|mrs|ms|dr|jr|sr|llc|inc|co|corp|company)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[b.length];
}

export // Schema migrations: ALTER TABLE for additive changes. Wrap each in try/catch
// because better-sqlite3 throws if the column already exists. Idempotent.
function safeAlter(sql) {
  try { db.exec(sql); } catch (e) { /* column already exists - OK */ }
}
safeAlter("ALTER TABLE gp_jobs ADD COLUMN invoice_total REAL");

function nameSimilarity(a, b) {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  const dist = levenshtein(na, nb);
  const maxLen = Math.max(na.length, nb.length);
  return 1 - dist / maxLen;
}

// ---------- Calculated columns (Part 4) ----------
function recalcGrossProfit(job) {
  const amount = num(job.amount_paid);
  if (amount == null) return { gp_dollars: null, gp_percent: null };
  const subtractions =
    num(job.fee_amount) +
    num(job.equipment_materials_total) +
    num(job.total_labor_cost) +
    num(job.sales_commission_amount) +
    num(job.sales_manager_fee) +
    num(job.permit_fee) +
    num(job.total_other_expenses);
  const gp = amount - subtractions;
  const pct = amount > 0 ? (gp / amount) * 100 : null;
  return { gp_dollars: round2(gp), gp_percent: pct == null ? null : round2(pct) };
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function round2(n) {
  if (n == null || !Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}

function applyComputed(jobId) {
  const job = db.prepare("SELECT * FROM gp_jobs WHERE id = ?").get(jobId);
  if (!job) return;

  // Sum line-item kinds that contribute to totals
  const labor = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM gp_line_items WHERE job_id = ? AND kind = 'labor'")
    .get(jobId).s;
  const other = db
    .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM gp_line_items WHERE job_id = ? AND kind = 'other_expense'")
    .get(jobId).s;

  const merged = { ...job, total_labor_cost: labor, total_other_expenses: other };
  const { gp_dollars, gp_percent } = recalcGrossProfit(merged);

  db.prepare(
    `UPDATE gp_jobs
       SET total_labor_cost = ?,
           total_other_expenses = ?,
           gross_profit_dollars = ?,
           gross_profit_percent = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(labor, other, gp_dollars, gp_percent, jobId);
}

// ---------- Jobs API ----------
export const GpJobs = {
  // Part 1: called by jobber-sync when an INVOICE_CREATE webhook (or polling)
  // discovers a new invoice. Idempotent by jobber_invoice_id.
  upsertFromInvoice({
    jobberInvoiceId,
    invoiceNumber,
    clientId,
    issuedAt,
    customerName,
    address,
    city,
    zip,
    amountPaid,
    invoiceTotal,
    paymentMethod,
    feeAmount,
    feeType,
    lineItems = [],   // [{ description, amount }]
  }) {
    const existing = db
      .prepare("SELECT id FROM gp_jobs WHERE jobber_invoice_id = ?")
      .get(jobberInvoiceId);

    let jobId;
    if (existing) {
      jobId = existing.id;
      db.prepare(
        `UPDATE gp_jobs SET
           jobber_invoice_number = COALESCE(?, jobber_invoice_number),
           jobber_client_id = COALESCE(?, jobber_client_id),
           jobber_invoice_issued_at = COALESCE(?, jobber_invoice_issued_at),
           customer_name = COALESCE(?, customer_name),
           address = COALESCE(?, address),
           city = COALESCE(?, city),
           zip = COALESCE(?, zip),
           amount_paid = COALESCE(?, amount_paid),
           invoice_total = COALESCE(?, invoice_total),
           payment_method = COALESCE(?, payment_method),
           fee_amount = COALESCE(?, fee_amount),
           fee_type = COALESCE(?, fee_type),
           jobber_synced_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(
        invoiceNumber, clientId, issuedAt,
        customerName, address, city, zip,
        amountPaid, invoiceTotal, paymentMethod, feeAmount, feeType,
        jobId
      );
    } else {
      const r = db.prepare(
        `INSERT INTO gp_jobs (
           jobber_invoice_id, jobber_invoice_number, jobber_client_id,
           jobber_invoice_issued_at, customer_name, address, city, zip,
           amount_paid, invoice_total, payment_method, fee_amount, fee_type,
           jobber_synced_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(
        jobberInvoiceId, invoiceNumber, clientId,
        issuedAt, customerName, address, city, zip,
        amountPaid, invoiceTotal, paymentMethod, feeAmount, feeType
      );
      jobId = r.lastInsertRowid;
    }

    // Replace invoice line items (they only come from Jobber)
    db.prepare("DELETE FROM gp_line_items WHERE job_id = ? AND source = 'jobber' AND kind = 'invoice_item'")
      .run(jobId);
    const insertLine = db.prepare(
      `INSERT INTO gp_line_items (job_id, kind, position, description, amount, source)
       VALUES (?, 'invoice_item', ?, ?, ?, 'jobber')`
    );
    lineItems.forEach((li, i) =>
      insertLine.run(jobId, i + 1, li.description || null, num(li.amount))
    );

    applyComputed(jobId);
    return jobId;
  },

  // Find candidate row(s) for a customer name within a date window. Used by
  // both the Sheet matcher (Part 2) and the supplier-invoice matcher (Part 3).
  // Returns matches sorted by similarity desc.
  findCandidatesByCustomer(customerName, { windowDays = 10, minSimilarity = 0.7 } = {}) {
    const all = db
      .prepare("SELECT * FROM gp_jobs ORDER BY jobber_invoice_issued_at DESC LIMIT 500")
      .all();
    const now = Date.now();
    const windowMs = windowDays * 24 * 60 * 60 * 1000;
    return all
      .map((row) => {
        const issued = row.jobber_invoice_issued_at
          ? new Date(row.jobber_invoice_issued_at).getTime()
          : null;
        const inWindow = issued == null || (now - issued) <= windowMs;
        const sim = nameSimilarity(customerName, row.customer_name);
        return { row, sim, inWindow };
      })
      .filter((x) => x.sim >= minSimilarity && x.inWindow)
      .sort((a, b) => b.sim - a.sim);
  },

  // Part 2: apply data from Chris's Google Sheet to an existing job.
  // Never overwrites existing non-null fields (per spec: "only add or update incomplete fields").
  applySheetData(jobId, sheet) {
    const job = db.prepare("SELECT * FROM gp_jobs WHERE id = ?").get(jobId);
    if (!job) throw new Error(`gp_jobs ${jobId} not found`);

    const set = (col, value) => {
      if (value == null || value === "") return;
      if (job[col] != null && job[col] !== "") return; // don't overwrite
      db.prepare(`UPDATE gp_jobs SET ${col} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(value, jobId);
      job[col] = value;
    };

    set("salesperson_name", sheet.salespersonName);
    set("sales_commission_amount", sheet.salesCommissionAmount);
    set("sales_commission_rate", sheet.salesCommissionRate);
    set("sales_manager_name", sheet.salesManagerName);
    set("sales_manager_fee", sheet.salesManagerFee);
    if (sheet.permitRequired != null) set("permit_required", sheet.permitRequired ? 1 : 0);
    set("permit_fee", sheet.permitFee);

    // Labor entries ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ replace existing 'labor' kind from sheet to avoid duplicates
    if (Array.isArray(sheet.labor) && sheet.labor.length) {
      db.prepare("DELETE FROM gp_line_items WHERE job_id = ? AND kind = 'labor' AND source = 'sheet'").run(jobId);
      const ins = db.prepare(
        `INSERT INTO gp_line_items (job_id, kind, position, labor_name, labor_type, amount, source)
         VALUES (?, 'labor', ?, ?, ?, ?, 'sheet')`
      );
      sheet.labor.forEach((l, i) =>
        ins.run(jobId, i + 1, l.name || null, l.type || null, num(l.cost))
      );
    }

    // Products sold from Chris's sheet
    if (Array.isArray(sheet.productsSold) && sheet.productsSold.length) {
      db.prepare("DELETE FROM gp_line_items WHERE job_id = ? AND kind = 'product_sold' AND source = 'sheet'").run(jobId);
      const ins = db.prepare(
        `INSERT INTO gp_line_items (job_id, kind, position, description, source)
         VALUES (?, 'product_sold', ?, ?, 'sheet')`
      );
      sheet.productsSold.forEach((p, i) => ins.run(jobId, i + 1, p));
    }

    // Other expenses
    if (Array.isArray(sheet.otherExpenses) && sheet.otherExpenses.length) {
      db.prepare("DELETE FROM gp_line_items WHERE job_id = ? AND kind = 'other_expense' AND source = 'sheet'").run(jobId);
      const ins = db.prepare(
        `INSERT INTO gp_line_items (job_id, kind, position, description, amount, source)
         VALUES (?, 'other_expense', ?, ?, ?, 'sheet')`
      );
      sheet.otherExpenses.forEach((o, i) =>
        ins.run(jobId, i + 1, o.type || null, num(o.cost))
      );
    }

    db.prepare(
      `UPDATE gp_jobs SET sheet_matched_at = CURRENT_TIMESTAMP, sheet_row_ref = ? WHERE id = ?`
    ).run(sheet.sheetRowRef || null, jobId);

    applyComputed(jobId);
  },

  // Part 3: a supplier invoice was parsed and matched to this job.
  // Costs are accumulated (multiple invoices for the same job add up).
  applySupplierInvoice(jobId, parsed) {
    const job = db.prepare("SELECT * FROM gp_jobs WHERE id = ?").get(jobId);
    if (!job) throw new Error(`gp_jobs ${jobId} not found`);

    const equipment = num(job.equipment_cost) + num(parsed.equipmentCost);
    const materials = num(job.materials_cost) + num(parsed.materialsCost);
    // The combined column includes sales tax per spec
    const total = num(job.equipment_materials_total) + num(parsed.totalWithTax || (parsed.equipmentCost + parsed.materialsCost));

    db.prepare(
      `UPDATE gp_jobs SET
         equipment_cost = ?,
         materials_cost = ?,
         equipment_materials_total = ?,
         supplier_invoices_synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(round2(equipment), round2(materials), round2(total), jobId);

    applyComputed(jobId);
  },

  list({ limit = 500, offset = 0, from = null, to = null } = {}) {
    // from/to are inclusive ISO date strings (YYYY-MM-DD or full ISO).
    // Filter by jobber_invoice_issued_at; rows with no issue date are kept only
    // when no filter is applied so they don't ghost-vanish from totals.
    const where = [];
    const params = [];
    if (from) { where.push("DATE(jobber_invoice_issued_at) >= DATE(?)"); params.push(from); }
    if (to)   { where.push("DATE(jobber_invoice_issued_at) <= DATE(?)"); params.push(to); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    return db
      .prepare(
        `SELECT * FROM gp_jobs ${whereSql} ORDER BY COALESCE(jobber_invoice_issued_at, created_at) DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
  },

  // Count rows matching the same filter ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ exposed so the page can show
  // `N invoices` for the current view (compare against Jobber).
  count({ from = null, to = null } = {}) {
    const where = [];
    const params = [];
    if (from) { where.push("DATE(jobber_invoice_issued_at) >= DATE(?)"); params.push(from); }
    if (to)   { where.push("DATE(jobber_invoice_issued_at) <= DATE(?)"); params.push(to); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    return db.prepare(`SELECT COUNT(*) AS n FROM gp_jobs ${whereSql}`).get(...params).n;
  },

  // Sum amount_paid for the same filter, used in the page header.
  sumAmountPaid({ from = null, to = null } = {}) {
    const where = [];
    const params = [];
    if (from) { where.push("DATE(jobber_invoice_issued_at) >= DATE(?)"); params.push(from); }
    if (to)   { where.push("DATE(jobber_invoice_issued_at) <= DATE(?)"); params.push(to); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    return db.prepare(`SELECT COALESCE(SUM(amount_paid), 0) AS s FROM gp_jobs ${whereSql}`).get(...params).s;
  },

  // Total invoiced (from invoice_total) for the date range. Older rows that
  // were synced before invoice_total existed contribute 0; re-running backfill
  // populates them.
  sumInvoiceTotal({ from = null, to = null } = {}) {
    const where = [];
    const params = [];
    if (from) { where.push("DATE(jobber_invoice_issued_at) >= DATE(?)"); params.push(from); }
    if (to)   { where.push("DATE(jobber_invoice_issued_at) <= DATE(?)"); params.push(to); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    return db.prepare(`SELECT COALESCE(SUM(invoice_total), 0) AS s FROM gp_jobs ${whereSql}`).get(...params).s;
  },

  // Returns counts and totals for the report header. Differentiates between:
  //   total       Ã¢ÂÂ every invoice in the date range (matches the table)
  //   paid        Ã¢ÂÂ invoices with amount_paid > 0
  //   info_complete Ã¢ÂÂ invoices that have data from all 3 sources
  //                  (Jobber amount_paid + supplier equip+mat + sheet labor)
  //   qualified   Ã¢ÂÂ paid AND info_complete (counts toward GP totals)
  // Only "qualified" rows roll up into total_sales / gp_dollars / gp_percent Ã¢ÂÂ
  // because a row missing labor cost would compute as 100% margin, which
  // misleads. Those totals match what you'd get summing the rows by hand.
  qualifiedSummary({ from = null, to = null } = {}) {
    const where = [];
    const params = [];
    if (from) { where.push("DATE(jobber_invoice_issued_at) >= DATE(?)"); params.push(from); }
    if (to)   { where.push("DATE(jobber_invoice_issued_at) <= DATE(?)"); params.push(to); }
    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
    // Quick boolean predicates inline as CASE expressions
    const paidExpr = "(amount_paid IS NOT NULL AND amount_paid > 0)";
    const infoExpr = "(amount_paid IS NOT NULL AND equipment_materials_total IS NOT NULL AND total_labor_cost IS NOT NULL)";
    const qualExpr = `(${paidExpr} AND ${infoExpr})`;
    const row = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN ${paidExpr} THEN 1 ELSE 0 END) AS paid,
        SUM(CASE WHEN ${infoExpr} THEN 1 ELSE 0 END) AS info_complete,
        SUM(CASE WHEN ${qualExpr} THEN 1 ELSE 0 END) AS qualified,
        COALESCE(SUM(CASE WHEN ${qualExpr} THEN amount_paid ELSE 0 END), 0) AS qualified_sales,
        COALESCE(SUM(CASE WHEN ${qualExpr} THEN gross_profit_dollars ELSE 0 END), 0) AS qualified_gp_dollars
      FROM gp_jobs
      ${whereSql}
    `).get(...params);
    const sales = Number(row.qualified_sales || 0);
    const gp = Number(row.qualified_gp_dollars || 0);
    return {
      total: Number(row.total || 0),
      paid: Number(row.paid || 0),
      info_complete: Number(row.info_complete || 0),
      qualified: Number(row.qualified || 0),
      qualified_sales: sales,
      qualified_gp_dollars: gp,
      qualified_gp_percent: sales > 0 ? (gp / sales) * 100 : null,
    };
  },

  byId(id) {
    const job = db.prepare("SELECT * FROM gp_jobs WHERE id = ?").get(id);
    if (!job) return null;
    job.line_items = db
      .prepare("SELECT * FROM gp_line_items WHERE job_id = ? ORDER BY kind, position")
      .all(id);
    job.attachments = db
      .prepare("SELECT * FROM gp_attachments WHERE job_id = ? ORDER BY created_at")
      .all(id);
    return job;
  },

};

// ---------- Attachments ----------
export const GpAttachments = {
  // Save the bytes to disk and record metadata. job_id may be null for
  // unmatched/inventory invoices (caller files the unmatched/inventory row separately).
  save({ jobId = null, source, supplier = null, filename, mimeType, bytes, metadata = null }) {
    const ts = Date.now();
    const safeName = String(filename).replace(/[^A-Za-z0-9._-]+/g, "_");
    const stored = `${ts}-${safeName}`;
    const fullPath = path.join(ATTACHMENT_DIR, stored);
    fs.writeFileSync(fullPath, bytes);
    const r = db.prepare(
      `INSERT INTO gp_attachments (job_id, source, supplier, filename, mime_type, size_bytes, storage_path, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      jobId, source, supplier, filename, mimeType || null,
      bytes.length, fullPath,
      metadata ? JSON.stringify(metadata) : null
    );
    return r.lastInsertRowid;
  },

  byJob(jobId) {
    return db.prepare("SELECT * FROM gp_attachments WHERE job_id = ? ORDER BY created_at").all(jobId);
  },

  byId(id) {
    return db.prepare("SELECT * FROM gp_attachments WHERE id = ?").get(id);
  },

  readBytes(id) {
    const a = this.byId(id);
    if (!a) return null;
    return fs.readFileSync(a.storage_path);
  },
};

// ---------- Unmatched / Inventory ----------
export const GpUnmatched = {
  add({ supplier, poName, totalAmount, attachmentId, notes }) {
    return db.prepare(
      `INSERT INTO gp_unmatched_invoices (supplier, po_name, total_amount, attachment_id, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).run(supplier, poName, totalAmount, attachmentId, notes || null).lastInsertRowid;
  },
  list() {
    return db.prepare(
      `SELECT u.*, a.filename, a.id AS att_id
         FROM gp_unmatched_invoices u
         LEFT JOIN gp_attachments a ON a.id = u.attachment_id
        WHERE u.resolved_to_job_id IS NULL
        ORDER BY u.created_at DESC`
    ).all();
  },
  resolve(unmatchedId, jobId) {
    db.prepare(
      `UPDATE gp_unmatched_invoices SET resolved_to_job_id = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(jobId, unmatchedId);
    // also re-link the attachment to the job
    const u = db.prepare("SELECT * FROM gp_unmatched_invoices WHERE id = ?").get(unmatchedId);
    if (u?.attachment_id) {
      db.prepare("UPDATE gp_attachments SET job_id = ? WHERE id = ?").run(jobId, u.attachment_id);
    }
  },
};

export const GpInventory = {
  add({ supplier, totalAmount, attachmentId, notes }) {
    return db.prepare(
      `INSERT INTO gp_inventory_invoices (supplier, total_amount, attachment_id, notes)
       VALUES (?, ?, ?, ?)`
    ).run(supplier, totalAmount, attachmentId, notes || null).lastInsertRowid;
  },
  list() {
    return db.prepare(
      `SELECT i.*, a.filename
         FROM gp_inventory_invoices i
         LEFT JOIN gp_attachments a ON a.id = i.attachment_id
        ORDER BY i.created_at DESC`
    ).all();
  },
};

// Utility re-exports for views
export { applyComputed as recomputeJob };
