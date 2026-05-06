// Google Sheets integration.
//
// Two responsibilities:
//   1. READ-ONLY scan of Chris's sheet (CHRIS_SHEET_ID) — pulls labor,
//      commissions, permits, other expenses; matches each row to a gp_jobs
//      row by customer name + 7-10 day window.
//   2. WRITE mirror to the Gross Profit Tracker sheet (MIRROR_SHEET_ID) —
//      one row per gp_jobs row, kept in sync.
//
// Auth: a Google service account. Set GOOGLE_SA_JSON to the JSON key (as a
// single-line string) or store the JSON at /etc/secrets/google-sa.json.
// Share both sheets with the service account's client_email.
//
// THE READER NEVER WRITES TO CHRIS'S SHEET. Strict rule.

import fs from "fs";
import { GpJobs, normalizeName } from "./gross-profit.js";

let googleClient = null;
let sheetsClient = null;

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  let creds;
  if (process.env.GOOGLE_SA_JSON) {
    try {
      creds = JSON.parse(process.env.GOOGLE_SA_JSON);
    } catch (e) {
      throw new Error("GOOGLE_SA_JSON is not valid JSON");
    }
  } else if (fs.existsSync("/etc/secrets/google-sa.json")) {
    creds = JSON.parse(fs.readFileSync("/etc/secrets/google-sa.json", "utf8"));
  } else {
    throw new Error("Google service account not configured (no GOOGLE_SA_JSON or /etc/secrets/google-sa.json)");
  }
  // Lazy import so the dep is optional
  const { google } = await import("googleapis");
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/drive.readonly",
    ],
  });
  await auth.authorize();
  googleClient = google;
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

export function isConfigured() {
  return Boolean(process.env.GOOGLE_SA_JSON || fs.existsSync("/etc/secrets/google-sa.json"));
}

export function status() {
  return {
    serviceAccount: isConfigured(),
    chrisSheetId: process.env.CHRIS_SHEET_ID || null,
    chrisSheetRange: process.env.CHRIS_SHEET_RANGE || "Sheet1!A1:Z",
    mirrorSheetId: process.env.MIRROR_SHEET_ID || null,
  };
}

// ---------- Chris's sheet — READER ----------
//
// We deliberately don't hard-code the column layout yet. The first scan
// pulls the header row and stores it; subsequent scans use it. When the
// user is ready they'll share the sheet URL and we'll either:
//   (a) accept a column map via env (CHRIS_SHEET_COLUMNS as JSON), or
//   (b) infer it from header text (e.g. "Customer", "Salesperson").
// Until then, scanChrisSheet() is a no-op that logs why.

const DEFAULT_COLUMN_HINTS = {
  customer:           ["customer", "client", "customer name"],
  salesperson:        ["salesperson", "sales person", "sold by"],
  salesCommissionAmount: ["sales commission", "commission $", "commission amount"],
  salesCommissionRate:   ["commission rate", "commission %"],
  salesManager:       ["sales manager", "manager"],
  salesManagerFee:    ["sales manager fee", "manager fee"],
  permitRequired:     ["permit", "permit required", "permit y/n"],
  permitFee:          ["permit fee"],
  // Repeating columns: laborName1/laborType1/laborCost1...laborName3/...
  // and otherExpenseType1/otherExpenseCost1...
};

function inferColumnMap(headerRow) {
  // Lowercase for matching
  const lower = headerRow.map((h) => String(h || "").trim().toLowerCase());
  const map = {};
  for (const [key, hints] of Object.entries(DEFAULT_COLUMN_HINTS)) {
    for (let i = 0; i < lower.length; i++) {
      if (hints.some((h) => lower[i] === h || lower[i].includes(h))) {
        map[key] = i;
        break;
      }
    }
  }
  // Repeating columns
  map.labor = []; // [{ nameCol, typeCol, costCol }]
  for (let n = 1; n <= 5; n++) {
    const nameCol = lower.findIndex((h) => h === `labor name ${n}` || h === `labor name${n}`);
    const typeCol = lower.findIndex((h) => h === `labor type ${n}` || h === `labor type${n}`);
    const costCol = lower.findIndex((h) => h === `labor cost ${n}` || h === `labor cost${n}`);
    if (nameCol >= 0 || costCol >= 0) map.labor.push({ nameCol, typeCol, costCol });
  }
  map.otherExpense = [];
  for (let n = 1; n <= 5; n++) {
    const typeCol = lower.findIndex((h) => h === `other expenses type ${n}` || h === `other expense type ${n}`);
    const costCol = lower.findIndex((h) => h === `other expenses cost ${n}` || h === `other expense cost ${n}`);
    if (typeCol >= 0 || costCol >= 0) map.otherExpense.push({ typeCol, costCol });
  }
  map.productsSold = [];
  for (let n = 1; n <= 5; n++) {
    const c = lower.findIndex((h) => h === `product sold ${n}` || h === `product sold${n}`);
    if (c >= 0) map.productsSold.push(c);
  }
  return map;
}

function rowToSheetData(row, map) {
  const get = (col) => (col != null && col >= 0 ? row[col] : null);
  const num = (v) => {
    if (v == null || v === "") return null;
    const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
    return Number.isFinite(n) ? n : null;
  };
  return {
    customerName: get(map.customer),
    salespersonName: get(map.salesperson) || null,
    salesCommissionAmount: num(get(map.salesCommissionAmount)),
    salesCommissionRate: num(get(map.salesCommissionRate)),
    salesManagerName: get(map.salesManager) || null,
    salesManagerFee: num(get(map.salesManagerFee)),
    permitRequired: (() => {
      const v = String(get(map.permitRequired) || "").toLowerCase().trim();
      if (!v) return null;
      return ["yes", "y", "true", "1"].includes(v);
    })(),
    permitFee: num(get(map.permitFee)),
    productsSold: (map.productsSold || []).map(get).filter((x) => x && String(x).trim()),
    labor: (map.labor || [])
      .map((l) => ({ name: get(l.nameCol), type: get(l.typeCol), cost: num(get(l.costCol)) }))
      .filter((l) => l.name || l.cost != null),
    otherExpenses: (map.otherExpense || [])
      .map((o) => ({ type: get(o.typeCol), cost: num(get(o.costCol)) }))
      .filter((o) => o.type || o.cost != null),
  };
}

export async function scanChrisSheet() {
  if (!isConfigured()) {
    return { skipped: true, reason: "service account not configured" };
  }
  const sheetId = process.env.CHRIS_SHEET_ID;
  if (!sheetId) {
    return { skipped: true, reason: "CHRIS_SHEET_ID env var not set" };
  }
  const range = process.env.CHRIS_SHEET_RANGE || "A1:Z1000";
  let rows;
  try {
    const sheets = await getSheetsClient();
    const r = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    rows = r.data.values || [];
  } catch (e) {
    return { skipped: false, error: e.message };
  }
  if (rows.length < 2) return { skipped: false, scanned: 0, matched: 0 };
  const header = rows[0];
  const map = inferColumnMap(header);
  if (map.customer == null) {
    return { skipped: false, error: "couldn't find 'Customer' column in Chris's sheet header" };
  }
  let matched = 0, ambiguous = 0, unmatched = 0;
  const ambiguousRows = [];
  for (let i = 1; i < rows.length; i++) {
    const data = rowToSheetData(rows[i], map);
    if (!data.customerName) continue;
    const cands = GpJobs.findCandidatesByCustomer(data.customerName, { windowDays: 10, minSimilarity: 0.85 });
    if (cands.length === 0) {
      unmatched++;
      continue;
    }
    if (cands.length > 1 && cands[0].sim - cands[1].sim < 0.05) {
      ambiguous++;
      ambiguousRows.push({ rowIndex: i + 1, customer: data.customerName, candidates: cands.slice(0, 3).map(c => ({ id: c.row.id, name: c.row.customer_name, sim: c.sim })) });
      continue;
    }
    try {
      GpJobs.applySheetData(cands[0].row.id, { ...data, sheetRowRef: `row ${i + 1}` });
      matched++;
    } catch (e) {
      console.warn(`[sheets] applySheetData failed for row ${i + 1}:`, e.message);
    }
  }
  return { scanned: rows.length - 1, matched, ambiguous, unmatched, ambiguousRows };
}

// ---------- Mirror writer ----------
//
// The Mirror sheet is a read-only export of gp_jobs rows. The portal owns
// the schema: headers are written on first sync, then data rows are
// updated/appended in mirror_row_index order.

const MIRROR_HEADERS = [
  "Job ID", "Invoice #", "Customer", "Address", "City", "Zip",
  "Amount Paid", "Payment Method", "Fee", "Fee Type",
  "Equipment Cost", "Materials Cost", "Equip+Mat Total",
  "Salesperson", "Sales Comm $", "Sales Comm %",
  "Sales Manager", "Sales Manager Fee",
  "Permit", "Permit Fee",
  "Total Labor", "Total Other",
  "Gross Profit $", "Gross Profit %",
  "Issued At", "Updated At",
];

function jobToMirrorRow(j) {
  return [
    j.id, j.jobber_invoice_number || "",
    j.customer_name || "", j.address || "", j.city || "", j.zip || "",
    j.amount_paid ?? "", j.payment_method || "",
    j.fee_amount ?? "", j.fee_type || "",
    j.equipment_cost ?? "", j.materials_cost ?? "", j.equipment_materials_total ?? "",
    j.salesperson_name || "", j.sales_commission_amount ?? "", j.sales_commission_rate ?? "",
    j.sales_manager_name || "", j.sales_manager_fee ?? "",
    j.permit_required ? "Yes" : (j.permit_required === 0 ? "No" : ""), j.permit_fee ?? "",
    j.total_labor_cost ?? "", j.total_other_expenses ?? "",
    j.gross_profit_dollars ?? "", j.gross_profit_percent ?? "",
    j.jobber_invoice_issued_at || "", j.updated_at || "",
  ];
}

export async function syncMirror() {
  if (!isConfigured()) {
    return { skipped: true, reason: "service account not configured" };
  }
  const sheetId = process.env.MIRROR_SHEET_ID;
  if (!sheetId) {
    return { skipped: true, reason: "MIRROR_SHEET_ID env var not set" };
  }
  const tabName = process.env.MIRROR_SHEET_TAB || "Jobs";

  const sheets = await getSheetsClient();
  const jobs = GpJobs.list({ limit: 5000 });
  const data = [MIRROR_HEADERS, ...jobs.map(jobToMirrorRow)];

  await sheets.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: `${tabName}!A1`,
    valueInputOption: "RAW",
    requestBody: { values: data },
  });
  // Optional: clear any rows below the new last row so deletes are reflected
  return { synced: jobs.length };
}
