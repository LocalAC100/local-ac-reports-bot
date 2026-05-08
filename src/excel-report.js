// Daily Excel report generator.
//
// Produces a multi-tab .xlsx that mirrors the manual v3 report Alex curated:
//   1. Summary           — key totals (5-bucket breakdown + new-lead response time)
//   2. All Calls         — every call row (master sheet, color-coded by category)
//   3. New Leads         — leads created today + first-call response time
//   4. By Dispatcher     — per-dispatcher rollup (with avg calls/contact)
//   5. By Pipeline       — per-pipeline rollup
//   6. By Pipeline Stage — pipeline → stage rollup
//   7. By Lead Age       — Today / 2-3d / 4-7d / 8+d buckets
//   8. Hourly            — hour-of-day rollup (ET)
//   9. By Outbound #     — per outbound DID rollup
//  10. Hour x Dispatcher — hour-of-day × dispatcher matrix
//  11. Notes             — methodology
//
// Source-of-truth: the local SQLite calls table (Calls.listInWindow). Pipeline /
// stage / lead-age data comes from GHL on-demand (listUsers, listPipelines,
// searchOpportunities, getContact). REAL_CALL_THRESHOLD is whatever
// classifyCall() in db.js uses (currently 70s).
//
// Exposed entry point:
//   buildDailyExcel(dateStr) → { filename, buffer }
//
// Used by reports.js (attaches to the morning + evening email) and by
// firehose-backfill.js (debug endpoint /admin/debug/build-excel for dryruns).

import ExcelJS from "exceljs";
import { DateTime } from "luxon";
import { Calls, classifyCall, isLiveTransfer, transferDestination } from "./db.js";
import * as ghl from "./ghl.js";
import { EMPLOYEES } from "./employees.js";

const TZ = "America/New_York";

// Outbound DID labeling — matches what the manual report used. Phone numbers
// are normalized to E.164-no-+ for the lookup.
const OUTBOUND_LABELS = {
  "14079046627": "Orlando 407-904-6627",
  "18139061143": "Tampa 813-906-1143",
};

// Ad-source filter for the New Leads tab.
// Only contacts whose `source` field matches one of these values are counted
// as "new leads received today". This matches Alex's manual report: he tracks
// only ad-driven leads (Instagram + Facebook), not inbound calls or contacts
// that landed in the CRM through other paths. Match is lowercased + trimmed.
// "an" appears in May 7 data — confirmed via inspect-leads endpoint as an
// ad-source variant. Combined with ig/fb (Instagram + Facebook lead-form
// codes), this covers all paid social leads. Add new codes here as we see
// them in the inspect-leads source-tally output.
const AD_SOURCES = new Set(["ig", "fb", "an", "instagram", "facebook"]);

function isAdSourceLead(c) {
  const s = String(c?.source || "").toLowerCase().trim();
  return AD_SOURCES.has(s);
}

const COLORS = {
  HEADER_BG: "FF1F4E78",
  HEADER_FG: "FFFFFFFF",
  TITLE_FG: "FF1F4E78",
  REAL_CALL: "FFDDEBF7",
  LIVE_TRANSFER: "FFE2EFDA",
  NO_ANSWER: null,
  FAILED: "FFFCE4D6",
  RINGING: "FFFFF2CC",
  TODAY_LEAD: "FFFCE4D6",
};

function normalizePhone(p) {
  if (!p) return "";
  return String(p).replace(/[^\d]/g, "");
}

function fmtDuration(sec) {
  sec = Number(sec || 0);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
}

function categoryLabel(bucket) {
  return {
    live_transfer: "Live Transfer",
    real_call: "Real Call",
    no_answer: "No Answer",
    failed: "Failed",
    ringing: "Ringing",
  }[bucket] || bucket;
}

function categoryFill(bucket) {
  return {
    live_transfer: COLORS.LIVE_TRANSFER,
    real_call: COLORS.REAL_CALL,
    no_answer: COLORS.NO_ANSWER,
    failed: COLORS.FAILED,
    ringing: COLORS.RINGING,
  }[bucket] || null;
}

function leadAgeBucket(days) {
  if (days == null) return "Unknown";
  if (days <= 1) return "Today";
  if (days <= 3) return "2-3 days";
  if (days <= 7) return "4-7 days";
  return "8+ days";
}

function hourLabel(h) {
  if (h === 0) return "12 AM";
  if (h < 12) return `${h} AM`;
  if (h === 12) return "12 PM";
  return `${h - 12} PM`;
}

function applyTitleStyle(cell) {
  cell.font = { name: "Arial", size: 16, bold: true, color: { argb: COLORS.TITLE_FG } };
}

function applyHeaderStyle(row) {
  row.eachCell((cell) => {
    cell.font = { name: "Arial", size: 10, bold: true, color: { argb: COLORS.HEADER_FG } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.HEADER_BG } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = { bottom: { style: "thin", color: { argb: "FFCCCCCC" } } };
  });
}

function setColumnWidths(ws, widths) {
  widths.forEach((w, i) => {
    if (w != null) ws.getColumn(i + 1).width = w;
  });
}

function buildDispatcherMap(ghlUsers) {
  const m = new Map();
  for (const u of ghlUsers || []) {
    m.set(u.id, pickDisplayName(u));
  }
  return m;
}

function pickDisplayName(ghlUser) {
  const email = (ghlUser?.email || "").toLowerCase();
  for (const e of EMPLOYEES) {
    if ((e.ghlEmail || "").toLowerCase() === email && e.fullName) return e.fullName;
  }
  return ghlUser?.name || `${ghlUser?.firstName || ""} ${ghlUser?.lastName || ""}`.trim() || "(unknown)";
}

async function buildPipelineIndex() {
  let pipelines = [];
  try { pipelines = await ghl.listPipelines(); } catch (e) {
    console.error("[excel] listPipelines failed", e?.message);
  }
  const byId = new Map();
  for (const p of pipelines) {
    const stagesById = new Map();
    for (const s of p.stages || []) stagesById.set(s.id, s.name);
    byId.set(p.id, { name: p.name, stagesById });
  }
  return { pipelines, byId };
}

async function buildContactPipelineMap(pipelineIndex) {
  const map = new Map();
  for (const p of pipelineIndex.pipelines) {
    let opps = [];
    try { opps = await ghl.searchOpportunities({ pipelineId: p.id, limit: 100 }); }
    catch (e) { console.error(`[excel] searchOpportunities pipeline=${p.id} failed`, e?.message); }
    for (const o of opps) {
      const cid = o.contactId || o.contact?.id;
      if (!cid) continue;
      const stageName = pipelineIndex.byId.get(p.id)?.stagesById?.get(o.pipelineStageId) || "";
      map.set(cid, { pipelineName: p.name, stageName });
    }
  }
  return map;
}

async function buildContactMap(contactIds, dateStr) {
  const map = new Map();
  const ids = [...new Set(contactIds.filter(Boolean))];
  const CONCURRENCY = 8;
  let i = 0;
  async function worker() {
    while (i < ids.length) {
      const id = ids[i++];
      try {
        const c = await ghl.getContact(id);
        if (c) map.set(id, c);
      } catch (e) {}
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return map;
}

function leadAgeDays(contact, reportDayEndIso) {
  if (!contact?.dateAdded) return null;
  const added = DateTime.fromISO(contact.dateAdded);
  const end = DateTime.fromISO(reportDayEndIso);
  if (!added.isValid || !end.isValid) return null;
  return Math.round((end.toMillis() - added.toMillis()) / 86400000 * 10) / 10;
}

function enrichCalls({ rows, dateStr, dispatcherMap, pipelineMap, contactMap }) {
  const reportDayStart = DateTime.fromISO(`${dateStr}T00:00:00`, { zone: TZ });
  const reportDayEnd = reportDayStart.endOf("day");
  const enriched = [];
  const perContactCount = new Map();
  for (const r of rows) {
    perContactCount.set(r.contact_id || r.phone || "", (perContactCount.get(r.contact_id || r.phone || "") || 0) + 1);
  }
  const perContactSeen = new Map();
  const sortedRows = [...rows].sort((a, b) => (a.date_added < b.date_added ? -1 : 1));
  for (const r of sortedRows) {
    let raw = {};
    try { if (r.raw_event) raw = JSON.parse(r.raw_event); } catch {}
    const participants = raw.participants || {};
    const transferred = isLiveTransfer({ participants });
    const transferTo = transferDestination({ participants });
    const bucket = classifyCall({ status: r.status, duration: r.duration, participants });
    const dt = DateTime.fromISO(r.date_added, { zone: "utc" }).setZone(TZ);
    const hour = dt.isValid ? dt.hour : null;
    const direction = (r.direction || "").toLowerCase();
    const dispName = direction === "inbound"
      ? "INBOUND"
      : (dispatcherMap.get(r.user_id) || "(unknown)");
    const fromNum = raw.from || r.phone || "";
    const toNum = raw.to || "";
    const fromKey = normalizePhone(fromNum);
    const fromLabel = OUTBOUND_LABELS[fromKey] || fromNum;
    const contact = contactMap.get(r.contact_id);
    const contactName = contact
      ? `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || contact.contactName || raw.contactName || ""
      : (raw.contactName || "");
    const ageDays = leadAgeDays(contact, reportDayEnd.toUTC().toISO());
    const ageBucket = leadAgeBucket(ageDays);
    const pipeline = pipelineMap.get(r.contact_id) || { pipelineName: "", stageName: "" };
    const newLeadToday = contact?.dateAdded
      ? DateTime.fromISO(contact.dateAdded) >= reportDayStart.toUTC() &&
        DateTime.fromISO(contact.dateAdded) <= reportDayEnd.toUTC()
      : false;
    const key = r.contact_id || r.phone || "";
    perContactSeen.set(key, (perContactSeen.get(key) || 0) + 1);
    enriched.push({
      raw: r, dt, hour, direction, from: fromNum, fromLabel, to: toNum,
      contactName,
      phone: r.phone || raw.from || raw.to || "",
      dispatcher: dispName,
      durationSec: r.duration || 0,
      durationFmt: fmtDuration(r.duration || 0),
      status: r.status || "",
      bucket,
      categoryLabel: categoryLabel(bucket),
      transferred, transferTo,
      pipelineName: pipeline.pipelineName,
      stageName: pipeline.stageName,
      ageDays, ageBucket, newLeadToday,
      callNumberToday: perContactSeen.get(key),
      totalCallsToday: perContactCount.get(key) || 0,
    });
  }
  return enriched;
}

function addSummaryTab(wb, { dateStr, totals, buckets, uniqueContacts, newLeadStats }) {
  const ws = wb.addWorksheet("Summary");
  setColumnWidths(ws, [36, 14, 12, 13, 13, 13]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Local AC — Daily Activity Report";
  ws.getCell("A2").value = `Date: ${dateStr} (Eastern Time) — pulled from HighLevel live data`;
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };
  ws.getCell("A4").value = "CATEGORIES";
  applyHeaderStyle(ws.getRow(4));
  const cats = [
    "• Live Transfer = call ≥70s AND transferred live to sales (transfer participant present)",
    "• Real Call = call ≥70s, no transfer (regular conversation)",
    "• No Answer = no-answer status + completed-but-<70s (voicemail pickups count here)",
    "• Failed = failed + busy (call dropped before reaching customer)",
    "• Ringing = transient state at query time (usually 0–1)",
  ];
  cats.forEach((t, i) => {
    const c = ws.getCell(`A${5 + i}`);
    c.value = t;
    c.font = { name: "Arial", size: 9, color: { argb: "FF606060" } };
  });
  ws.getCell("A12").value = "KEY TOTALS — TODAY";
  applyHeaderStyle(ws.getRow(12));
  ws.getRow(13).values = ["Metric", "Count", "% of total"];
  applyHeaderStyle(ws.getRow(13));
  const total = totals.both;
  const pct = (n) => total > 0 ? (n / total) : 0;
  const rows = [
    ["Total calls (in + out)", total, ""],
    ["  Live Transfer", buckets.live_transfer, pct(buckets.live_transfer)],
    ["  Real Call", buckets.real_call, pct(buckets.real_call)],
    ["  No Answer", buckets.no_answer, pct(buckets.no_answer)],
    ["  Failed", buckets.failed, pct(buckets.failed)],
    ["  Ringing (anomaly)", buckets.ringing, pct(buckets.ringing)],
    ["Unique contacts called", uniqueContacts, ""],
    ["Avg calls per contact", uniqueContacts ? Math.round((total / uniqueContacts) * 100) / 100 : 0, ""],
    ["New leads received today", newLeadStats.totalNewLeads, ""],
  ];
  rows.forEach((r, i) => {
    const row = ws.getRow(14 + i);
    row.values = r;
    if (typeof r[2] === "number") row.getCell(3).numFmt = "0.0%";
  });
  ws.getCell("A24").value = "NEW LEAD RESPONSE TIME (goal: ≤ 1 min, never > 3 min)";
  applyHeaderStyle(ws.getRow(24));
  const leadRows = [
    ["Total new leads", newLeadStats.totalNewLeads],
    ["Average response time", newLeadStats.avgResponseLabel || "—"],
    ["Median response time", newLeadStats.medianResponseLabel || "—"],
    [`Called within 1 minute`, `${newLeadStats.within1} (${newLeadStats.totalNewLeads ? Math.round(newLeadStats.within1 / newLeadStats.totalNewLeads * 100) : 0}%)`],
    [`Called within 3 minutes`, `${newLeadStats.within3} (${newLeadStats.totalNewLeads ? Math.round(newLeadStats.within3 / newLeadStats.totalNewLeads * 100) : 0}%)`],
    [`Took longer than 3 minutes`, `${newLeadStats.over3} (${newLeadStats.totalNewLeads ? Math.round(newLeadStats.over3 / newLeadStats.totalNewLeads * 100) : 0}%)`],
    ["Never called", newLeadStats.neverCalled],
  ];
  leadRows.forEach((r, i) => { ws.getRow(25 + i).values = r; });
}

function addAllCallsTab(wb, calls) {
  const ws = wb.addWorksheet("All Calls");
  ws.views = [{ state: "frozen", ySplit: 4 }];
  setColumnWidths(ws, [18, 6, 9, 22, 13, 16, 18, 12, 10, 12, 14, 13, 16, 22, 13, 12, 14, 13, 12, 14]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = `All Calls — Master Sheet (${calls.length} rows)`;
  ws.getCell("A2").value = "Each row = one call. Filter on any column. Color-coded by category.";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };
  const headers = [
    "Date/Time (ET)", "Hour", "Direction", "From Number", "Contact Name", "Phone",
    "Dispatcher", "Duration (sec)", "Duration", "Status (raw)", "Category",
    "Live Transfer?", "Transfer To", "Pipeline", "Stage", "Lead Age (days)",
    "Lead Age Bucket", "New Lead Today?", "Call # (today)", "Total calls (today, this contact)",
  ];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };
  calls.forEach((c, i) => {
    const r = ws.getRow(5 + i);
    r.values = [
      c.dt.isValid ? c.dt.toFormat("yyyy-LL-dd HH:mm:ss") : "",
      c.hour, c.direction, c.fromLabel, c.contactName, c.phone, c.dispatcher,
      c.durationSec, c.durationFmt, c.status, c.categoryLabel,
      c.transferred ? "Yes" : "", c.transferTo || "",
      c.pipelineName, c.stageName, c.ageDays, c.ageBucket,
      c.newLeadToday ? "Yes" : "", c.callNumberToday, c.totalCallsToday,
    ];
    const fill = categoryFill(c.bucket);
    if (fill) {
      r.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
      });
    }
  });
}

function addByDispatcherTab(wb, calls) {
  const ws = wb.addWorksheet("By Dispatcher");
  setColumnWidths(ws, [22, 14, 13, 13, 13, 13, 16, 18, 22]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Calls by Dispatcher (with avg per contact)";
  ws.getCell("A2").value = "Target: 2–3 calls per lead. Avg cell turns red below 2, green between 2 and 3.";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };
  const headers = ["Dispatcher", "Total", "Live Transfer", "Real Call", "No Answer", "Failed", "Unique Contacts", "Avg calls/contact", "% Real (incl. transfer)"];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));
  const byDisp = new Map();
  for (const c of calls) {
    const key = c.dispatcher;
    if (!byDisp.has(key)) byDisp.set(key, {
      total: 0, live_transfer: 0, real_call: 0, no_answer: 0, failed: 0, ringing: 0, contacts: new Set(),
    });
    const d = byDisp.get(key);
    d.total++; d[c.bucket]++;
    if (c.raw.contact_id) d.contacts.add(c.raw.contact_id);
  }
  const ordered = [...byDisp.entries()].sort((a, b) => {
    if (a[0] === "INBOUND") return 1;
    if (b[0] === "INBOUND") return -1;
    return b[1].total - a[1].total;
  });
  ordered.forEach(([name, d], i) => {
    const uniq = d.contacts.size;
    const realPlus = d.real_call + d.live_transfer;
    const pctReal = d.total > 0 ? (realPlus / d.total) : 0;
    const row = ws.getRow(5 + i);
    row.values = [
      name, d.total, d.live_transfer, d.real_call, d.no_answer, d.failed,
      uniq,
      uniq ? Math.round((d.total / uniq) * 100) / 100 : 0,
      pctReal,
    ];
    row.getCell(9).numFmt = "0.0%";
  });
}

function addByPipelineTab(wb, calls) {
  const ws = wb.addWorksheet("By Pipeline");
  setColumnWidths(ws, [26, 14, 13, 13, 13, 13, 16]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Calls by Pipeline";
  const headers = ["Pipeline", "Total", "Live Transfer", "Real Call", "No Answer", "Failed", "Unique Contacts"];
  ws.getRow(3).values = headers;
  applyHeaderStyle(ws.getRow(3));
  const m = new Map();
  for (const c of calls) {
    const key = c.pipelineName || "(no pipeline)";
    if (!m.has(key)) m.set(key, { total: 0, live_transfer: 0, real_call: 0, no_answer: 0, failed: 0, ringing: 0, contacts: new Set() });
    const d = m.get(key);
    d.total++; d[c.bucket]++;
    if (c.raw.contact_id) d.contacts.add(c.raw.contact_id);
  }
  const ordered = [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  ordered.forEach(([name, d], i) => {
    ws.getRow(4 + i).values = [name, d.total, d.live_transfer, d.real_call, d.no_answer, d.failed, d.contacts.size];
  });
}

function addByPipelineStageTab(wb, calls) {
  const ws = wb.addWorksheet("By Pipeline Stage");
  setColumnWidths(ws, [42, 14, 13, 13, 13, 13, 16]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Calls by Pipeline + Stage";
  const headers = ["Pipeline → Stage", "Total", "Live Transfer", "Real Call", "No Answer", "Failed", "Unique Contacts"];
  ws.getRow(3).values = headers;
  applyHeaderStyle(ws.getRow(3));
  const m = new Map();
  for (const c of calls) {
    const key = `${c.pipelineName || "(no pipeline)"} → ${c.stageName || "(no stage)"}`;
    if (!m.has(key)) m.set(key, { total: 0, live_transfer: 0, real_call: 0, no_answer: 0, failed: 0, ringing: 0, contacts: new Set() });
    const d = m.get(key);
    d.total++; d[c.bucket]++;
    if (c.raw.contact_id) d.contacts.add(c.raw.contact_id);
  }
  const ordered = [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  ordered.forEach(([name, d], i) => {
    ws.getRow(4 + i).values = [name, d.total, d.live_transfer, d.real_call, d.no_answer, d.failed, d.contacts.size];
  });
}

function addByLeadAgeTab(wb, calls) {
  const ws = wb.addWorksheet("By Lead Age");
  setColumnWidths(ws, [18, 14, 13, 13, 13, 13, 16]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Calls by Lead Age Bucket";
  ws.getCell("A2").value = "Buckets: Today (≤1 day), 2-3 days, 4-7 days, 8+ days";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };
  const headers = ["Lead Age", "Total", "Live Transfer", "Real Call", "No Answer", "Failed", "Unique Contacts"];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));
  const ORDER = ["Today", "2-3 days", "4-7 days", "8+ days", "Unknown"];
  const m = new Map(ORDER.map(k => [k, { total: 0, live_transfer: 0, real_call: 0, no_answer: 0, failed: 0, ringing: 0, contacts: new Set() }]));
  for (const c of calls) {
    const k = ORDER.includes(c.ageBucket) ? c.ageBucket : "Unknown";
    const d = m.get(k);
    d.total++; d[c.bucket]++;
    if (c.raw.contact_id) d.contacts.add(c.raw.contact_id);
  }
  ORDER.forEach((k, i) => {
    const d = m.get(k);
    if (d.total === 0 && k === "Unknown") return;
    ws.getRow(5 + i).values = [k, d.total, d.live_transfer, d.real_call, d.no_answer, d.failed, d.contacts.size];
  });
}

function addHourlyTab(wb, calls) {
  const ws = wb.addWorksheet("Hourly");
  setColumnWidths(ws, [14, 13, 13, 13, 13, 13]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Calls by Hour (Eastern Time)";
  const headers = ["Hour", "Total", "Live Transfer", "Real Call", "No Answer", "Failed"];
  ws.getRow(3).values = headers;
  applyHeaderStyle(ws.getRow(3));
  const m = new Map();
  for (const c of calls) {
    if (c.hour == null) continue;
    if (!m.has(c.hour)) m.set(c.hour, { total: 0, live_transfer: 0, real_call: 0, no_answer: 0, failed: 0, ringing: 0 });
    const d = m.get(c.hour);
    d.total++; d[c.bucket]++;
  }
  const hours = [...m.keys()].sort((a, b) => a - b);
  hours.forEach((h, i) => {
    const d = m.get(h);
    ws.getRow(4 + i).values = [hourLabel(h), d.total, d.live_transfer, d.real_call, d.no_answer, d.failed];
  });
}

function addByOutboundTab(wb, calls) {
  const ws = wb.addWorksheet("By Outbound #");
  setColumnWidths(ws, [26, 14, 13, 13, 13, 13, 16]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Calls by Outbound (From) Number";
  const headers = ["From Number", "Total", "Live Transfer", "Real Call", "No Answer", "Failed", "Unique Contacts"];
  ws.getRow(3).values = headers;
  applyHeaderStyle(ws.getRow(3));
  const m = new Map();
  for (const c of calls) {
    if (c.direction !== "outbound") continue;
    const key = c.fromLabel || c.from || "(unknown)";
    if (!m.has(key)) m.set(key, { total: 0, live_transfer: 0, real_call: 0, no_answer: 0, failed: 0, ringing: 0, contacts: new Set() });
    const d = m.get(key);
    d.total++; d[c.bucket]++;
    if (c.raw.contact_id) d.contacts.add(c.raw.contact_id);
  }
  const ordered = [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  ordered.forEach(([name, d], i) => {
    ws.getRow(4 + i).values = [name, d.total, d.live_transfer, d.real_call, d.no_answer, d.failed, d.contacts.size];
  });
}

function addHourXDispatcherTab(wb, calls) {
  const ws = wb.addWorksheet("Hour x Dispatcher");
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Calls per Hour per Dispatcher";
  ws.getCell("A2").value = "Cell value = total calls that hour by that dispatcher.";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };
  const dispSet = new Set(calls.map(c => c.dispatcher));
  let dispatchers = [...dispSet].filter(d => d !== "INBOUND").sort();
  if (dispSet.has("INBOUND")) dispatchers.push("INBOUND");
  const headers = ["Hour", ...dispatchers, "Hour Total"];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));
  setColumnWidths(ws, [12, ...dispatchers.map(() => 14), 13]);
  const matrix = new Map();
  for (const c of calls) {
    if (c.hour == null) continue;
    if (!matrix.has(c.hour)) matrix.set(c.hour, new Map());
    const inner = matrix.get(c.hour);
    inner.set(c.dispatcher, (inner.get(c.dispatcher) || 0) + 1);
  }
  const hours = [...matrix.keys()].sort((a, b) => a - b);
  hours.forEach((h, i) => {
    const inner = matrix.get(h);
    const rowVals = [hourLabel(h)];
    let total = 0;
    for (const d of dispatchers) {
      const n = inner.get(d) || 0;
      total += n;
      rowVals.push(n || null);
    }
    rowVals.push(total);
    ws.getRow(5 + i).values = rowVals;
  });
  const totalRowIdx = 5 + hours.length;
  const totRowVals = ["TOTAL"];
  for (let col = 0; col < dispatchers.length; col++) {
    let s = 0;
    for (const h of hours) s += (matrix.get(h).get(dispatchers[col]) || 0);
    totRowVals.push(s);
  }
  totRowVals.push(totRowVals.slice(1).reduce((a, b) => a + b, 0));
  ws.getRow(totalRowIdx).values = totRowVals;
  ws.getRow(totalRowIdx).font = { bold: true };
}

function addNewLeadsTab(wb, newLeadRows) {
  const ws = wb.addWorksheet("New Leads");
  ws.views = [{ state: "frozen", ySplit: 4 }];
  setColumnWidths(ws, [24, 16, 12, 20, 20, 14, 16, 18, 50, 12]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = `New Leads Today — Response Time (${newLeadRows.length} leads)`;
  ws.getCell("A2").value = "Goal: call back within 1 minute, never beyond 3 minutes.";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };
  const headers = ["Lead Name", "Phone", "Lead Source", "Came In (ET)", "First Call (ET)", "Response Time", "Bucket", "First Caller", "Other Dispatchers on Shift (within 30 min)", "Total calls today"];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));
  newLeadRows.forEach((r, i) => {
    const row = ws.getRow(5 + i);
    row.values = [
      r.leadName, r.phone, r.leadSource,
      r.cameIn, r.firstCall, r.responseTime, r.bucket,
      r.firstCaller, r.othersOnShift, r.totalCallsToday,
    ];
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.TODAY_LEAD } };
    });
  });
}

function addNotesTab(wb) {
  const ws = wb.addWorksheet("Notes");
  ws.getColumn(1).width = 130;
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = "Notes & Methodology";
  const lines = [
    null,
    ["How categories are defined", { bold: true, color: COLORS.TITLE_FG, size: 11 }],
    "Live Transfer — duration ≥70s AND a \"transfer:\" participant is present in the call record.",
    "Real Call — duration ≥70s, no transfer participant. Genuine conversation.",
    "No Answer — status no-answer + (status completed AND duration <70s). Voicemail pickups land here.",
    "Failed — status failed + busy.",
    "Ringing — transient state at query time.",
    null,
    ["Verification routine", { bold: true, color: COLORS.TITLE_FG, size: 11 }],
    "This script reconciles against the bucket-counts endpoint: outbound + inbound = total, classifyCall() identical to db.js.",
    "Cross-check against HighLevel UI: Outgoing donut, Duration ≥70s filter, single-dispatcher filter.",
    null,
    ["Time zone", { bold: true, color: COLORS.TITLE_FG, size: 11 }],
    "All hour buckets are Eastern Time. EDT (UTC-4) March-November, EST (UTC-5) November-March.",
    null,
    ["Pipeline + lead age", { bold: true, color: COLORS.TITLE_FG, size: 11 }],
    "Each contact's pipeline + stage comes from their most-recently-updated opportunity.",
    "Lead age is days from contact.dateAdded to end-of-report-window. Buckets: Today / 2-3 / 4-7 / 8+.",
  ];
  let r = 2;
  for (const item of lines) {
    if (item == null) { r++; continue; }
    if (Array.isArray(item)) {
      const [text, style] = item;
      const cell = ws.getCell(`A${r}`);
      cell.value = text;
      cell.font = { name: "Arial", size: style.size || 10, bold: style.bold, color: { argb: style.color } };
    } else {
      const cell = ws.getCell(`A${r}`);
      cell.value = item;
      cell.font = { name: "Arial", size: 10 };
    }
    r++;
  }
}

function buildNewLeads({ contactMap, calls, dateStr }) {
  const reportStart = DateTime.fromISO(`${dateStr}T00:00:00`, { zone: TZ }).toUTC();
  const reportEnd   = DateTime.fromISO(`${dateStr}T23:59:59.999`, { zone: TZ }).toUTC();
  const leads = [];
  for (const c of contactMap.values()) {
    if (!c?.dateAdded) continue;
    if (!isAdSourceLead(c)) continue;  // ad-source only (Instagram + Facebook)
    const added = DateTime.fromISO(c.dateAdded);
    if (!added.isValid) continue;
    if (added < reportStart || added > reportEnd) continue;
    leads.push(c);
  }
  const firstCallByContact = new Map();
  for (const call of calls) {
    if (call.direction !== "outbound") continue;
    if (!call.raw.contact_id) continue;
    const prev = firstCallByContact.get(call.raw.contact_id);
    if (!prev || call.dt < prev.dt) firstCallByContact.set(call.raw.contact_id, call);
  }
  const totalCallsByContact = new Map();
  for (const call of calls) {
    const k = call.raw.contact_id;
    if (!k) continue;
    totalCallsByContact.set(k, (totalCallsByContact.get(k) || 0) + 1);
  }
  const responseSecs = [];
  let within1 = 0, within3 = 0, over3 = 0, neverCalled = 0;
  const rows = leads.map((l) => {
    const first = firstCallByContact.get(l.id);
    let responseTimeSec = null;
    let bucket = "Never called";
    let firstCallEt = "";
    if (first) {
      const added = DateTime.fromISO(l.dateAdded);
      const fcEt = first.dt;
      responseTimeSec = Math.round((fcEt.toMillis() - added.toMillis()) / 1000);
      responseSecs.push(responseTimeSec);
      firstCallEt = fcEt.toFormat("yyyy-LL-dd HH:mm:ss");
      if (responseTimeSec <= 60) { bucket = "≤ 1 min"; within1++; within3++; }
      else if (responseTimeSec <= 180) { bucket = "≤ 3 min"; within3++; }
      else if (responseTimeSec <= 300) { bucket = "> 3 min"; over3++; }
      else { bucket = "> 5 min (BAD)"; over3++; }
    } else {
      neverCalled++;
    }
    return {
      leadName: `${l.firstName || ""} ${l.lastName || ""}`.trim() || l.contactName || "(no name)",
      phone: l.phone,
      leadSource: l.source || "",
      cameIn: DateTime.fromISO(l.dateAdded).setZone(TZ).toFormat("yyyy-LL-dd HH:mm:ss"),
      firstCall: firstCallEt,
      responseTime: responseTimeSec != null ? fmtDuration(responseTimeSec) : "Never",
      bucket,
      firstCaller: first?.dispatcher || "",
      othersOnShift: "",
      totalCallsToday: totalCallsByContact.get(l.id) || 0,
    };
  });
  rows.sort((a, b) => a.cameIn < b.cameIn ? -1 : 1);
  const avg = responseSecs.length ? Math.round(responseSecs.reduce((a, b) => a + b, 0) / responseSecs.length) : null;
  const sorted = [...responseSecs].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  return {
    rows,
    stats: {
      totalNewLeads: leads.length,
      within1, within3, over3, neverCalled,
      avgResponseLabel: avg != null ? fmtDuration(avg) : null,
      medianResponseLabel: median != null ? fmtDuration(median) : null,
    },
  };
}

export async function buildDailyExcel(dateStr) {
  const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
  const dayEnd = dayStart.endOf("day");
  const fromIso = dayStart.toUTC().toISO();
  const toIso = dayEnd.toUTC().toISO();
  const rows = Calls.listInWindow(fromIso, toIso, 5000);
  const [users, pipelineIndex] = await Promise.all([
    ghl.listUsers().catch((e) => { console.error("[excel] listUsers failed", e?.message); return []; }),
    buildPipelineIndex(),
  ]);
  const dispatcherMap = buildDispatcherMap(users);
  const [pipelineMap, contactMap] = await Promise.all([
    buildContactPipelineMap(pipelineIndex),
    buildContactMap(rows.map((r) => r.contact_id), dateStr),
  ]);
  let newContacts = [];
  try {
    newContacts = await ghl.searchContacts({ from: fromIso, to: toIso, limit: 100 });
  } catch (e) { console.error("[excel] searchContacts failed", e?.message); }
  for (const c of newContacts) if (c?.id && !contactMap.has(c.id)) contactMap.set(c.id, c);
  const calls = enrichCalls({ rows, dateStr, dispatcherMap, pipelineMap, contactMap });
  const { rows: newLeadRows, stats: newLeadStats } = buildNewLeads({ contactMap, calls, dateStr });
  const totals = {
    outbound: rows.filter((r) => (r.direction || "").toLowerCase() === "outbound").length,
    inbound:  rows.filter((r) => (r.direction || "").toLowerCase() === "inbound").length,
    both: rows.length,
  };
  const buckets = { live_transfer: 0, real_call: 0, no_answer: 0, failed: 0, ringing: 0 };
  for (const c of calls) buckets[c.bucket]++;
  const uniqueContacts = new Set(rows.map((r) => r.contact_id || r.phone || "").filter(Boolean)).size;
  const wb = new ExcelJS.Workbook();
  wb.creator = "Local AC Reports Bot";
  wb.lastModifiedBy = "Local AC Reports Bot";
  wb.created = new Date();
  wb.modified = new Date();
  addSummaryTab(wb, { dateStr, totals, buckets, uniqueContacts, newLeadStats });
  addAllCallsTab(wb, calls);
  addNewLeadsTab(wb, newLeadRows);
  addByDispatcherTab(wb, calls);
  addByPipelineTab(wb, calls);
  addByPipelineStageTab(wb, calls);
  addByLeadAgeTab(wb, calls);
  addHourlyTab(wb, calls);
  addByOutboundTab(wb, calls);
  addHourXDispatcherTab(wb, calls);
  addNotesTab(wb);
  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Local_AC_Daily_Report_${dateStr}.xlsx`;
  return { filename, buffer };
}
