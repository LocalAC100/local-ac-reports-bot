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
      // GHL returns createdAt on the opportunity. Fall back to dateAdded.
      // When a known phone/email re-submits the lead form, GHL dedupes the
      // contact but creates a NEW opportunity with createdAt = now. So
      // opportunity.createdAt is the most reliable "lead came in" signal —
      // more reliable than contact.dateAdded which only fires on FIRST submit.
      // Capture every "opp had activity today" candidate timestamp:
      // - createdAt: original opp creation (rarely today on resubmission since GHL dedupes)
      // - lastStatusChangeAt: bumped when status (open/won/lost) changes; ALSO bumped on opp creation
      // - lastStageChangeAt: bumped when pipeline stage moves
      // Take the most recent of the three as oppLastActivity — that's the
      // "this opportunity touched something today" signal.
      const tses = [o.createdAt, o.dateAdded, o.lastStatusChangeAt, o.lastStageChangeAt, o.updatedAt]
        .filter(Boolean)
        .map((t) => new Date(t).getTime())
        .filter((n) => !Number.isNaN(n));
      const oppLastActivity = tses.length ? new Date(Math.max(...tses)).toISOString() : null;
      const oppCreatedAt = o.createdAt || o.dateAdded || null;
      map.set(cid, { pipelineName: p.name, stageName, oppCreatedAt, oppLastActivity });
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

function addSummaryTab(wb, { dateStr, totals, buckets, uniqueContacts, newLeadStats, reactivatedStats }) {
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
  ws.getCell("A24").value = "NEW LEADS — first-time contacts (goal: call back ≤ 1 min, never > 3 min)";
  applyHeaderStyle(ws.getRow(24));
  const nl = newLeadStats.newLeads || {};
  const leadRows = [
    ["Total new leads", nl.total ?? 0],
    ["Average response time", nl.avgResponseLabel || "—"],
    ["Median response time", nl.medianResponseLabel || "—"],
    [`Called within 1 minute`, `${nl.within1 ?? 0} (${nl.total ? Math.round((nl.within1 ?? 0) / nl.total * 100) : 0}%)`],
    [`Called within 3 minutes`, `${nl.within3 ?? 0} (${nl.total ? Math.round((nl.within3 ?? 0) / nl.total * 100) : 0}%)`],
    [`Took longer than 3 minutes`, `${nl.over3 ?? 0} (${nl.total ? Math.round((nl.over3 ?? 0) / nl.total * 100) : 0}%)`],
    ["Never called", nl.neverCalled ?? 0],
  ];
  leadRows.forEach((r, i) => { ws.getRow(25 + i).values = r; });

  // New Opportunities block (re-submitted leads — contact already existed)
  const noStartRow = 25 + leadRows.length + 2;
  ws.getCell(`A${noStartRow}`).value = "REPEAT SUBMISSIONS — old contacts with opp activity today";
  applyHeaderStyle(ws.getRow(noStartRow));
  const no = newLeadStats.newOpps || {};
  const oppRows = [
    ["Total repeat submissions", no.total ?? 0],
    ["Average response time", no.avgResponseLabel || "—"],
    ["Median response time", no.medianResponseLabel || "—"],
    [`Called within 1 minute`, `${no.within1 ?? 0} (${no.total ? Math.round((no.within1 ?? 0) / no.total * 100) : 0}%)`],
    [`Called within 3 minutes`, `${no.within3 ?? 0} (${no.total ? Math.round((no.within3 ?? 0) / no.total * 100) : 0}%)`],
    [`Took longer than 3 minutes`, `${no.over3 ?? 0} (${no.total ? Math.round((no.over3 ?? 0) / no.total * 100) : 0}%)`],
    ["Never called", no.neverCalled ?? 0],
  ];
  oppRows.forEach((r, i) => { ws.getRow(noStartRow + 1 + i).values = r; });

  // Reactivated leads block — placed below New Opportunities
  if (reactivatedStats) {
    const startRow = noStartRow + 1 + oppRows.length + 2;
    ws.getCell(`A${startRow}`).value = "REACTIVATED LEADS (old leads with activity today)";
    applyHeaderStyle(ws.getRow(startRow));
    const reactRows = [
      ["Total reactivated", reactivatedStats.total],
      ["Booked appointment", reactivatedStats.booked],
      ["Did not book", reactivatedStats.notBooked],
      [`Booking rate`, reactivatedStats.total > 0 ? `${reactivatedStats.booked} of ${reactivatedStats.total} (${Math.round(reactivatedStats.bookingRate * 100)}%)` : "—"],
    ];
    reactRows.forEach((r, i) => { ws.getRow(startRow + 1 + i).values = r; });
  }
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

function addNewOpportunitiesTab(wb, newOppRows) {
  const ws = wb.addWorksheet("Repeat Submissions");
  ws.views = [{ state: "frozen", ySplit: 4 }];
  setColumnWidths(ws, [24, 16, 12, 14, 20, 20, 14, 16, 18, 50, 12]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = `Repeat Submissions Today — Old contacts whose opp had activity today (${newOppRows.length} opportunities)`;
  ws.getCell("A2").value = "Old contacts whose opportunity was touched today (createdAt / lastStatusChangeAt / lastStageChangeAt). Often means they re-submitted the lead form, but can also fire on workflow stage moves.";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };

  const headers = ["Contact", "Phone", "Lead Source", "Lead Type", "Came In (ET)", "First Call (ET)", "Response Time", "Bucket", "First Caller", "Other Dispatchers on Shift (within 30 min)", "Total calls today"];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));

  newOppRows.forEach((r, i) => {
    const row = ws.getRow(5 + i);
    row.values = [
      r.leadName, r.phone, r.leadSource, r.leadType,
      r.cameIn, r.firstCall, r.responseTime, r.bucket,
      r.firstCaller, r.othersOnShift, r.totalCallsToday,
    ];
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.LIVE_TRANSFER } };
    });
  });
}

function addNewLeadsTab(wb, newLeadRows) {
  const ws = wb.addWorksheet("New Leads");
  ws.views = [{ state: "frozen", ySplit: 4 }];
  setColumnWidths(ws, [24, 16, 12, 14, 20, 20, 14, 16, 18, 50, 12]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = `New Leads Today — Response Time (${newLeadRows.length} leads)`;
  ws.getCell("A2").value = "Goal: call back within 1 minute, never beyond 3 minutes.";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };
  const headers = ["Lead Name", "Phone", "Lead Source", "Lead Type", "Came In (ET)", "First Call (ET)", "Response Time", "Bucket", "First Caller", "Other Dispatchers on Shift (within 30 min)", "Total calls today"];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));
  newLeadRows.forEach((r, i) => {
    const row = ws.getRow(5 + i);
    row.values = [
      r.leadName, r.phone, r.leadSource, r.leadType,
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

function buildNewLeads({ contactMap, pipelineMap, calls, dateStr }) {
  const reportStart = DateTime.fromISO(`${dateStr}T00:00:00`, { zone: TZ }).toUTC();
  const reportEnd   = DateTime.fromISO(`${dateStr}T23:59:59.999`, { zone: TZ }).toUTC();
  const leads = [];
  // Per Alex: count ANY contact created today, regardless of source — manual
  // entries, ad leads, inbound, all of it. ALSO count contacts whose
  // opportunity was created today even if their contact dateAdded is older —
  // GHL dedupes contacts on phone/email match, so a re-submitted lead form
  // updates the existing contact (dateAdded stays old) but creates a fresh
  // opportunity with createdAt = today. The text-notification system fires
  // on the workflow tied to opportunity creation, so this matches what Alex
  // sees in his text history.
  for (const c of contactMap.values()) {
    if (!c?.id) continue;
    const opp = pipelineMap.get(c.id);
    const contactAdded = c.dateAdded ? DateTime.fromISO(c.dateAdded) : null;
    const oppActivity = opp?.oppLastActivity ? DateTime.fromISO(opp.oppLastActivity) : null;

    const contactToday = contactAdded?.isValid && contactAdded >= reportStart && contactAdded <= reportEnd;
    const oppToday = oppActivity?.isValid && oppActivity >= reportStart && oppActivity <= reportEnd;

    if (!contactToday && !oppToday) continue;

    // Lead type: "New Lead" = contact created today (first time we've ever seen them).
    // "Repeat Submission" = older contact whose opportunity had activity today
    // (resubmitted ad form, workflow re-fired, stage changed, etc.).
    const leadType = contactToday ? "New Lead" : "Repeat Submission";

    leads.push({ ...c, _leadType: leadType, _opp: opp });
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
      // Same logic as cameInIso below: re-submitted leads use opp.createdAt.
      const cameInForResponse = l._leadType === "Repeat Submission" && l._opp?.oppLastActivity
        ? l._opp.oppLastActivity
        : l.dateAdded;
      const added = DateTime.fromISO(cameInForResponse);
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
    // For "Came In" timestamp: prefer contact.dateAdded for first-time leads,
    // opportunity.createdAt for re-submitted leads (since contact.dateAdded
    // would point to the original sign-up date, not today's resubmission).
    const cameInIso = l._leadType === "Repeat Submission" && l._opp?.oppLastActivity
      ? l._opp.oppLastActivity
      : l.dateAdded;
    return {
      leadName: `${l.firstName || ""} ${l.lastName || ""}`.trim() || l.contactName || "(no name)",
      phone: l.phone,
      leadSource: l.source || "",
      cameIn: DateTime.fromISO(cameInIso).setZone(TZ).toFormat("yyyy-LL-dd HH:mm:ss"),
      firstCall: firstCallEt,
      responseTime: responseTimeSec != null ? fmtDuration(responseTimeSec) : "Never",
      bucket,
      firstCaller: first?.dispatcher || "",
      othersOnShift: "",
      totalCallsToday: totalCallsByContact.get(l.id) || 0,
      leadType: l._leadType || "New Lead",
      _respSec: responseTimeSec,
    };
  });
  rows.sort((a, b) => a.cameIn < b.cameIn ? -1 : 1);
  const avg = responseSecs.length ? Math.round(responseSecs.reduce((a, b) => a + b, 0) / responseSecs.length) : null;
  const sorted = [...responseSecs].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  // Split rows by lead type so Alex sees New Leads and New Opportunities
  // as separate categories in the workbook.
  const newLeadRows = rows.filter((r) => r.leadType === "New Lead");
  const newOppRows  = rows.filter((r) => r.leadType === "Repeat Submission");

  // Per-group response-time stats for the Summary tab.
  function statsFor(group) {
    const respSecs = group.map((r) => r._respSec).filter((n) => n != null);
    const w1 = group.filter((r) => r.bucket === "≤ 1 min").length;
    const w3 = group.filter((r) => r.bucket === "≤ 1 min" || r.bucket === "≤ 3 min").length;
    const o3 = group.filter((r) => r.bucket === "> 3 min" || r.bucket === "> 5 min (BAD)").length;
    const nc = group.filter((r) => r.bucket === "Never called").length;
    const avgS = respSecs.length ? Math.round(respSecs.reduce((a, b) => a + b, 0) / respSecs.length) : null;
    const sortedS = [...respSecs].sort((a, b) => a - b);
    const medS = sortedS.length ? sortedS[Math.floor(sortedS.length / 2)] : null;
    return {
      total: group.length,
      within1: w1, within3: w3, over3: o3, neverCalled: nc,
      avgResponseLabel: avgS != null ? fmtDuration(avgS) : null,
      medianResponseLabel: medS != null ? fmtDuration(medS) : null,
    };
  }

  return {
    newLeadRows,
    newOppRows,
    stats: {
      newLeads: statsFor(newLeadRows),
      newOpps:  statsFor(newOppRows),
      totalNewLeads: newLeadRows.length,
      avgResponseLabel: avg != null ? fmtDuration(avg) : null,
      medianResponseLabel: median != null ? fmtDuration(median) : null,
      within1, within3, over3, neverCalled,
    },
  };
}

function buildReactivatedLeads({ contactMap, pipelineMap, calls, dateStr }) {
  // OLD lead = contact whose dateAdded is BEFORE the report day.
  // We surface old leads who had a meaningful interaction today:
  //   - answered the phone (real_call: ≥70s, no transfer)
  //   - got transferred to sales (live_transfer)
  //   - reached "Appt. Booked" or "Over Phone Booked" stage in their pipeline
  // Each row is also flagged with whether the contact ENDED up booked, so we
  // can show a booking-rate metric (e.g. "3 of 8 reactivated leads booked").
  const reportStart = DateTime.fromISO(`${dateStr}T00:00:00`, { zone: TZ }).toUTC();
  const BOOKING_STAGES = new Set(["Appt. Booked", "Over Phone Booked"]);

  const callsByContact = new Map();
  for (const c of calls) {
    const id = c.raw.contact_id;
    if (!id) continue;
    if (!callsByContact.has(id)) callsByContact.set(id, []);
    callsByContact.get(id).push(c);
  }

  const out = [];
  const seen = new Set();

  // Pass 1: any old contact who got a real_call or live_transfer today
  for (const [id, contactCalls] of callsByContact.entries()) {
    const contact = contactMap.get(id);
    if (!contact?.dateAdded) continue;
    const added = DateTime.fromISO(contact.dateAdded);
    if (!added.isValid) continue;
    if (added >= reportStart) continue;

    const meaningful = contactCalls.filter((c) => c.bucket === "real_call" || c.bucket === "live_transfer");
    if (meaningful.length === 0) continue;

    meaningful.sort((a, b) => {
      const rank = { live_transfer: 0, real_call: 1 };
      if (rank[a.bucket] !== rank[b.bucket]) return rank[a.bucket] - rank[b.bucket];
      return b.dt.toMillis() - a.dt.toMillis();
    });
    const best = meaningful[0];
    const pipeline = pipelineMap.get(id) || {};
    const ageDays = Math.floor((reportStart.toMillis() - added.toMillis()) / 86400000);
    const booked = BOOKING_STAGES.has(pipeline.stageName || "");

    seen.add(id);
    out.push({
      name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || contact.contactName || "(no name)",
      phone: contact.phone,
      source: contact.source || "",
      dateAdded: added.setZone(TZ).toFormat("yyyy-LL-dd"),
      ageDays,
      activity: best.bucket === "live_transfer" ? "Live Transfer" : "Real Call",
      dispatcher: best.dispatcher,
      activityTime: best.dt.toFormat("HH:mm:ss"),
      durationFmt: best.durationFmt,
      pipeline: pipeline.pipelineName || "",
      stage: pipeline.stageName || "",
      booked,
      _sortTs: best.dt.toMillis(),
    });
  }

  // Pass 2: old contacts whose opportunity is in a booked stage but had no
  // qualifying call today — still counts as a reactivation (link click,
  // manual entry, etc.).
  for (const [id, pipeline] of pipelineMap.entries()) {
    if (!BOOKING_STAGES.has(pipeline.stageName || "")) continue;
    if (seen.has(id)) continue;
    const contact = contactMap.get(id);
    if (!contact?.dateAdded) continue;
    const added = DateTime.fromISO(contact.dateAdded);
    if (!added.isValid) continue;
    if (added >= reportStart) continue;

    const ageDays = Math.floor((reportStart.toMillis() - added.toMillis()) / 86400000);
    out.push({
      name: `${contact.firstName || ""} ${contact.lastName || ""}`.trim() || contact.contactName || "(no name)",
      phone: contact.phone,
      source: contact.source || "",
      dateAdded: added.setZone(TZ).toFormat("yyyy-LL-dd"),
      ageDays,
      activity: pipeline.stageName === "Appt. Booked" ? "Appt. Booked (no call)" : "Phone Sale (no call)",
      dispatcher: "",
      activityTime: "",
      durationFmt: "",
      pipeline: pipeline.pipelineName || "",
      stage: pipeline.stageName || "",
      booked: true,
      _sortTs: 0,
    });
  }

  out.sort((a, b) => b._sortTs - a._sortTs);

  // Aggregate stats for the Summary tab.
  const bookedCount = out.filter((r) => r.booked).length;
  const stats = {
    total: out.length,
    booked: bookedCount,
    notBooked: out.length - bookedCount,
    bookingRate: out.length > 0 ? bookedCount / out.length : 0,
  };

  return { rows: out, stats };
}

function addReactivatedLeadsTab(wb, rows, stats) {
  const ws = wb.addWorksheet("Reactivated Leads");
  ws.views = [{ state: "frozen", ySplit: 4 }];
  setColumnWidths(ws, [22, 16, 8, 13, 8, 22, 18, 12, 11, 22, 22, 10]);
  applyTitleStyle(ws.getCell("A1"));
  ws.getCell("A1").value = `Reactivated Leads — Old contacts with activity today (${rows.length} leads, ${stats.booked} booked)`;
  ws.getCell("A2").value = "Old lead = contact created before today. Activity = real call ≥70s, live transfer, or pipeline stage moved to a booked stage.";
  ws.getCell("A2").font = { name: "Arial", size: 10, italic: true, color: { argb: "FF606060" } };

  const headers = ["Contact", "Phone", "Source", "Created", "Age (days)", "Activity Today", "Dispatcher", "Time (ET)", "Duration", "Pipeline", "Stage", "Booked?"];
  ws.getRow(4).values = headers;
  applyHeaderStyle(ws.getRow(4));
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };

  rows.forEach((r, i) => {
    const row = ws.getRow(5 + i);
    row.values = [
      r.name, r.phone, r.source, r.dateAdded, r.ageDays,
      r.activity, r.dispatcher, r.activityTime, r.durationFmt,
      r.pipeline, r.stage, r.booked ? "Yes" : "No",
    ];
    const fill = r.booked
      ? COLORS.LIVE_TRANSFER
      : (r.activity === "Live Transfer" ? COLORS.LIVE_TRANSFER : COLORS.REAL_CALL);
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fill } };
    });
  });
}

export async function buildDailyExcel(dateStr) {
  const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
  const dayEnd = dayStart.endOf("day");
  const fromIso = dayStart.toUTC().toISO();
  const toIso = dayEnd.toUTC().toISO();
  const rows = Calls.listInWindow(fromIso, toIso, 5000);
  // PHASE 1 — small, fast queries done FIRST, in parallel.
  // searchContacts is the most rate-limit-sensitive query (returns up to 100
  // contacts created today, matters for the New Leads tab). Running it before
  // the heavy getContact storm avoids GHL 429s.
  let newContacts = [];
  let searchError = null;
  const [users, pipelineIndex, _newContacts] = await Promise.all([
    ghl.listUsers().catch((e) => { console.error("[excel] listUsers failed", e?.message); return []; }),
    buildPipelineIndex(),
    ghl.searchContacts({ from: fromIso, to: toIso, limit: 100 }).catch((e) => {
      searchError = e?.response?.data || e?.message;
      console.error("[excel] searchContacts failed", searchError);
      return [];
    }),
  ]);
  newContacts = _newContacts || [];
  const dispatcherMap = buildDispatcherMap(users);

  // PHASE 2 — opportunities pull (one call per pipeline, max 4 pipelines).
  const pipelineMap = await buildContactPipelineMap(pipelineIndex);

  // PHASE 3 — seed contactMap from searchContacts, then fill in the remaining
  // call-driven contact_ids via getContact. This keeps total getContact volume
  // to (unique calls) - (already-known via search), reducing rate-limit risk.
  const contactMap = new Map();
  for (const c of newContacts) if (c?.id) contactMap.set(c.id, c);
  const sizeBeforeMerge = contactMap.size;
  const callContactIds = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];
  const idsToFetch = callContactIds.filter((id) => !contactMap.has(id));
  const fetched = await buildContactMap(idsToFetch, dateStr);
  for (const [id, c] of fetched.entries()) {
    if (!contactMap.has(id)) contactMap.set(id, c);  // search wins on overlap
  }
  console.log(`[excel] searchContacts: ${newContacts.length}, getContact: ${fetched.size}, total contactMap: ${contactMap.size}, searchError: ${searchError ? JSON.stringify(searchError) : "none"}`);
  const calls = enrichCalls({ rows, dateStr, dispatcherMap, pipelineMap, contactMap });
  const { newLeadRows, newOppRows, stats: newLeadStats } = buildNewLeads({ contactMap, pipelineMap, calls, dateStr });
  const { rows: reactivatedRows, stats: reactivatedStats } = buildReactivatedLeads({ contactMap, pipelineMap, calls, dateStr });
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
  addSummaryTab(wb, { dateStr, totals, buckets, uniqueContacts, newLeadStats, reactivatedStats });
  addAllCallsTab(wb, calls);
  addNewLeadsTab(wb, newLeadRows);
  addNewOpportunitiesTab(wb, newOppRows);
  addReactivatedLeadsTab(wb, reactivatedRows, reactivatedStats);
  addByDispatcherTab(wb, calls);
  addByPipelineTab(wb, calls);
  addByPipelineStageTab(wb, calls);
  addByLeadAgeTab(wb, calls);
  addHourlyTab(wb, calls);
  addByOutboundTab(wb, calls);
  addHourXDispatcherTab(wb, calls);
  addNotesTab(wb);

  // Diagnostic tab with counts useful for debugging
  const dws = wb.addWorksheet("_Diagnostic");
  dws.getCell("A1").value = "Diagnostic — counts at build time";
  dws.getCell("A1").font = { bold: true, size: 14 };
  dws.getCell("A2").value = `contactMap before searchContacts merge: ${sizeBeforeMerge}`;
  dws.getCell("A3").value = `contactMap after searchContacts merge: ${contactMap.size}`;
  dws.getCell("A4").value = `searchContacts returned: ${newContacts.length}`;
  dws.getCell("A5").value = `searchContacts error: ${searchError ? JSON.stringify(searchError) : "none"}`;
  dws.getCell("A6").value = `total calls in window: ${rows.length}`;
  dws.getCell("A7").value = `unique contact_ids in calls: ${new Set(rows.map((r) => r.contact_id).filter(Boolean)).size}`;
  dws.getColumn(1).width = 90;

  // Probe for specific names Alex mentioned that don't show in May-7 dateAdded.
  // Lists every match in contactMap with its actual dateAdded so we can see
  // what GHL has on file.
  const probeNames = ["hardwood", "coggle", "rivadeneira", "rivedebeira"];
  dws.getCell("A9").value = "Name probes (contacts in fetched set whose name contains the keyword, regardless of dateAdded):";
  dws.getCell("A9").font = { bold: true };
  let probeRow = 10;
  for (const probe of probeNames) {
    const matches = [];
    for (const c of contactMap.values()) {
      const fn = String(c?.firstName || "").toLowerCase();
      const ln = String(c?.lastName || "").toLowerCase();
      const cn = String(c?.contactName || "").toLowerCase();
      if (fn.includes(probe) || ln.includes(probe) || cn.includes(probe)) {
        matches.push(`${c.firstName || ""} ${c.lastName || ""}`.trim() + ` | source=${c.source} | dateAdded=${c.dateAdded} | phone=${c.phone}`);
      }
    }
    dws.getCell(`A${probeRow++}`).value = `  "${probe}": ${matches.length === 0 ? "no match in contactMap" : matches.join(" || ")}`;
  }

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `Local_AC_Daily_Report_${dateStr}.xlsx`;
  return { filename, buffer };
}
