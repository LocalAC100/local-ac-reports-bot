// Google Sheets integration - Chris's Pay Calculation Sheet.
//
// Two responsibilities:
//   1. READ-ONLY scan of Chris's sheet (CHRIS_SHEET_ID) - pulls labor,
//      commissions, permits, other expenses; matches each row to a gp_jobs
//      row by customer name + 30-day window.
//   2. WRITE mirror to the Gross Profit Tracker sheet (MIRROR_SHEET_ID) -
//      one row per gp_jobs row, kept in sync.
//
// Auth: a Google service account. Set GOOGLE_SA_JSON to the JSON key (as a
// single-line string) or store the JSON at /etc/secrets/google-sa.json.
// Share BOTH sheets with the service account's client_email.
//
// THE READER NEVER WRITES TO CHRIS'S SHEET. Strict invariant.
//
// ----- Column layout (fixed, from user spec) -----
// SALES tab columns (1-indexed):
//   G  =  payment method (Cash / Check / Aqua Financing / Renew Financing)
//   H  =  salesperson name
//   K  =  financing or CC fee amount
//   L  =  permit required (yes / no)
//   BR =  other expenses cost (sum of all "other" expenses)
//   BU =  commission rate (%)
//   BW =  sales commission amount ($)
//   BY =  sales manager fee ($)
//   M, O, Q  =  product sold 1, 2, 3
// JOBS tab columns:
//   F  =  labor type (Sub / Employee)
//   M  =  labor name
//   P  =  labor cost
//
// Customer-name match: SALES tab is expected to have the customer name in
// column B (override via SHEET_CUSTOMER_COL env var). JOBS tab same default
// (override via JOBS_CUSTOMER_COL).

import { google } from "googleapis";
import fs from "fs";
import { GpJobs } from "./gross-profit.js";

const CHRIS_SHEET_ID = process.env.CHRIS_SHEET_ID || "";
const SALES_RANGE    = process.env.CHRIS_SALES_RANGE || "SALES!A1:CA";
const JOBS_RANGE     = process.env.CHRIS_JOBS_RANGE  || "JOBS!A1:Z";
const SALES_CUSTOMER_COL = (process.env.SHEET_CUSTOMER_COL || "B").toUpperCase();
const JOBS_CUSTOMER_COL  = (process.env.JOBS_CUSTOMER_COL  || "B").toUpperCase();
const MIRROR_SHEET_ID = process.env.MIRROR_SHEET_ID || "";
const MIRROR_TAB      = process.env.MIRROR_SHEET_TAB || "GP Tracker";

// Convert column letter ("A", "Z", "AA", "BW") -> 0-indexed column number
function col(letter) {
  let n = 0;
  for (const ch of String(letter).toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

const SALES = {
  customer:        col(SALES_CUSTOMER_COL),
  paymentMethod:   col("G"),
  salesperson:     col("H"),
  fee:             col("K"),
  permit:          col("L"),
  product1:        col("M"),
  product2:        col("O"),
  product3:        col("Q"),
  otherExpenses:   col("BR"),
  commissionRate:  col("BU"),
  commissionAmt:   col("BW"),
  salesMgrFee:     col("BY"),
};

const JOBS = {
  customer:   col(JOBS_CUSTOMER_COL),
  laborType:  col("F"),
  laborName:  col("M"),
  laborCost:  col("P"),
};

// ---------- Auth ----------
let cachedAuth = null;
function getAuth() {
  if (cachedAuth) return cachedAuth;
  let credsJson = process.env.GOOGLE_SA_JSON;
  if (!credsJson) {
    try {
      credsJson = fs.readFileSync("/etc/secrets/google-sa.json", "utf8");
    } catch (e) { /* not present */ }
  }
  if (!credsJson) return null;
  let parsed;
  try { parsed = JSON.parse(credsJson); }
  catch (e) {
    console.warn("[sheets] GOOGLE_SA_JSON is not valid JSON:", e.message);
    return null;
  }
  cachedAuth = new google.auth.JWT({
    email: parsed.client_email,
    key: parsed.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return cachedAuth;
}

export function isConfigured() {
  return Boolean(getAuth() && CHRIS_SHEET_ID);
}

export function status() {
  const auth = getAuth();
  return {
    sheets_auth: auth ? "service-account configured" : "GOOGLE_SA_JSON not set",
    chris_sheet_id: CHRIS_SHEET_ID || "(unset)",
    sales_range: SALES_RANGE,
    jobs_range: JOBS_RANGE,
    mirror_sheet_id: MIRROR_SHEET_ID || "(unset)",
  };
}

// ---------- Helpers ----------
function asMoney(v) {
  if (v == null || v === "") return null;
  const cleaned = String(v).replace(/[$,\s]/g, "");
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}
function asYesNo(v) {
  if (v == null || v === "") return null;
  const s = String(v).trim().toLowerCase();
  if (["yes", "y", "true", "1", "x"].includes(s)) return 1;
  if (["no", "n", "false", "0"].includes(s)) return 0;
  return null;
}
function asPercent(v) {
  if (v == null || v === "") return null;
  const cleaned = String(v).replace(/[%\s]/g, "");
  const n = parseFloat(cleaned);
  if (!isFinite(n)) return null;
  return n;
}

// ---------- Sheet reads ----------
async function readRange(sheetId, range) {
  const auth = getAuth();
  if (!auth) throw new Error("Google service account not configured");
  const sheets = google.sheets({ version: "v4", auth });
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
  return r.data.values || [];
}

function parseSalesRow(row) {
  return {
    customerName:           row[SALES.customer] || null,
    paymentMethod:          row[SALES.paymentMethod] || null,
    salespersonName:        row[SALES.salesperson] || null,
    feeAmount:              asMoney(row[SALES.fee]),
    permitRequired:         asYesNo(row[SALES.permit]),
    salesCommissionAmount:  asMoney(row[SALES.commissionAmt]),
    salesCommissionRate:    asPercent(row[SALES.commissionRate]),
    salesManagerFee:        asMoney(row[SALES.salesMgrFee]),
    totalOtherExpenses:     asMoney(row[SALES.otherExpenses]),
    productsSold: [
      row[SALES.product1] || null,
      row[SALES.product2] || null,
      row[SALES.product3] || null,
    ].filter(Boolean),
  };
}

function parseJobsRow(row) {
  return {
    customerName: row[JOBS.customer] || null,
    laborType:    row[JOBS.laborType] || null,
    laborName:    row[JOBS.laborName] || null,
    laborCost:    asMoney(row[JOBS.laborCost]),
  };
}

// ---------- Public scan ----------
// Reads SALES + JOBS tabs, matches each row to a gp_jobs row by customer name
// (with a rolling time window), and applies the parsed data via
// GpJobs.applySheetData / GpJobs.applyLaborItems. Never writes to Chris's sheet.
export async function scanChrisSheet() {
  if (!isConfigured()) {
    return { skipped: true, reason: "GOOGLE_SA_JSON or CHRIS_SHEET_ID not set" };
  }
  const out = {
    sales: { scanned: 0, matched: 0, unmatched: 0, ambiguous: 0, errors: 0 },
    jobs:  { scanned: 0, matched: 0, unmatched: 0, errors: 0 },
  };

  // SALES tab
  let salesRows;
  try {
    salesRows = await readRange(CHRIS_SHEET_ID, SALES_RANGE);
  } catch (e) {
    return { error: `SALES read failed: ${e.message}` };
  }
  // Skip header row (assume row 1 is headers)
  for (let i = 1; i < salesRows.length; i++) {
    const data = parseSalesRow(salesRows[i] || []);
    if (!data.customerName) continue;
    out.sales.scanned++;
    const cands = GpJobs.findCandidatesByCustomer(data.customerName, { windowDays: 30, minSimilarity: 0.85 });
    if (cands.length === 0) { out.sales.unmatched++; continue; }
    if (cands.length > 1 && cands[0].sim - cands[1].sim < 0.05) { out.sales.ambiguous++; continue; }
    try {
      GpJobs.applySheetData(cands[0].row.id, {
        sheetRowRef:           `SALES!A${i + 1}`,
        salespersonName:       data.salespersonName,
        salesCommissionAmount: data.salesCommissionAmount,
        salesCommissionRate:   data.salesCommissionRate,
        salesManagerFee:       data.salesManagerFee,
        permitRequired:        data.permitRequired,
        feeAmount:             data.feeAmount,
        paymentMethod:         data.paymentMethod,
        totalOtherExpenses:    data.totalOtherExpenses,
      });
      out.sales.matched++;
    } catch (e) {
      console.warn(`[sheets] SALES row ${i + 1} apply failed:`, e.message);
      out.sales.errors++;
    }
  }

  // JOBS tab - labor lines. Multiple rows per customer is OK; we sum cost.
  let jobsRows = [];
  try {
    jobsRows = await readRange(CHRIS_SHEET_ID, JOBS_RANGE);
  } catch (e) {
    out.jobs.error = `JOBS read failed: ${e.message}`;
    return out;
  }
  const laborByCustomer = new Map();
  for (let i = 1; i < jobsRows.length; i++) {
    const d = parseJobsRow(jobsRows[i] || []);
    if (!d.customerName) continue;
    const arr = laborByCustomer.get(d.customerName) || [];
    arr.push({ name: d.laborName, type: d.laborType, cost: d.laborCost, rowIndex: i + 1 });
    laborByCustomer.set(d.customerName, arr);
  }
  for (const [customer, laborItems] of laborByCustomer) {
    out.jobs.scanned++;
    const cands = GpJobs.findCandidatesByCustomer(customer, { windowDays: 30, minSimilarity: 0.85 });
    if (cands.length === 0) { out.jobs.unmatched++; continue; }
    const totalLabor = laborItems.reduce((s, x) => s + (x.cost || 0), 0);
    try {
      GpJobs.applyLaborItems(cands[0].row.id, {
        sheetRowRef: `JOBS!A${laborItems[0].rowIndex}`,
        totalLaborCost: totalLabor,
        items: laborItems.map((x) => ({
          laborName: x.name,
          laborType: x.type,
          amount:    x.cost,
        })),
      });
      out.jobs.matched++;
    } catch (e) {
      console.warn(`[sheets] JOBS apply failed for ${customer}:`, e.message);
      out.jobs.errors++;
    }
  }
  return out;
}

// ---------- Mirror writer ----------
export async function syncMirror() {
  if (!getAuth() || !MIRROR_SHEET_ID) {
    return { skipped: true, reason: "GOOGLE_SA_JSON or MIRROR_SHEET_ID not set" };
  }
  const jobs = GpJobs.list({ limit: 5000 });
  const header = [
    "Customer", "Address", "City", "Invoice #", "Issued",
    "Amount Paid", "Invoice Total", "Pay Method", "Fee $", "Fee Type",
    "Salesperson", "Commission $", "Commission %",
    "Sales Mgr Fee", "Permit?", "Permit Fee",
    "Equipment $", "Materials $", "Equip+Mat $",
    "Labor $", "Other Expenses",
    "GP $", "GP %",
  ];
  const rows = jobs.map((j) => [
    j.customer_name || "", j.address || "", j.city || "", j.jobber_invoice_number || "", j.jobber_invoice_issued_at || "",
    j.amount_paid ?? "", j.invoice_total ?? "", j.payment_method || "", j.fee_amount ?? "", j.fee_type || "",
    j.salesperson_name || "", j.sales_commission_amount ?? "", j.sales_commission_rate ?? "",
    j.sales_manager_fee ?? "", j.permit_required == null ? "" : (j.permit_required ? "Yes" : "No"), j.permit_fee ?? "",
    j.equipment_cost ?? "", j.materials_cost ?? "", j.equipment_materials_total ?? "",
    j.total_labor_cost ?? "", j.total_other_expenses ?? "",
    j.gross_profit_dollars ?? "", j.gross_profit_percent == null ? "" : j.gross_profit_percent.toFixed(1) + "%",
  ]);
  const sheets = google.sheets({ version: "v4", auth: getAuth() });
  await sheets.spreadsheets.values.clear({
    spreadsheetId: MIRROR_SHEET_ID,
    range: `${MIRROR_TAB}!A:Z`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: MIRROR_SHEET_ID,
    range: `${MIRROR_TAB}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: [header, ...rows] },
  });
  return { rows: rows.length };
}
