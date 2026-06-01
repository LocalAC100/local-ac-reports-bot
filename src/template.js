// template.js — May 7 "NEW REPORT FORMAT MOCKUP v2" aligned design.
// v3 — Sections 3/5/6 rendered from buildDailyExcel data.
// v4 — Red flags removed, Slow Response removed, Section 4 split out so order
//      is 1→2→3→4→5→6, Section 6 expanded to match approved mockup (pipeline
//      cards + stage breakdown + lead-age × dispatcher + booking funnel
//      narrative), per-section summary footers, Hubstaff renderer made
//      defensive about clock/status field shapes.

import { DateTime } from "luxon";
import { EMPLOYEES, expectedShiftFor } from "./employees.js";
import { TZ, fmtTime, fmtDuration } from "./time.js";

// =====================================================================
// Shared CSS — cherry-picked from email-mockup.html (the approved design).
// =====================================================================
const STYLES = `<style>
body { margin: 0; background: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; color: #333; }
.container { max-width: 980px; margin: 0 auto; background: white; padding: 0; }
.banner { background: linear-gradient(135deg, #1f4e78 0%, #2563eb 100%); color: white; padding: 28px 32px; border-radius: 0 0 8px 8px; margin-bottom: 8px; }
.banner .eyebrow { font-size: 12px; letter-spacing: 2px; color: #93c5fd; text-transform: uppercase; }
.banner h1 { margin: 4px 0 8px; font-size: 28px; }
.banner .meta { font-size: 13px; opacity: 0.85; }
.section { background: white; margin: 12px 16px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 20px 24px; }
.section h2 { margin: 0 0 4px; color: #1f4e78; font-size: 18px; }
.section .subhead { color: #6b7280; font-size: 12px; margin-bottom: 16px; }
.section .summary-footer { margin-top: 14px; padding: 8px 12px; background: #f0f9ff; border-left: 3px solid #0284c7; border-radius: 4px; color: #0c4a6e; font-size: 12px; line-height: 1.5; }
table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0; }
th { background: #1f4e78; color: white; text-align: left; padding: 7px 8px; font-weight: 600; font-size: 11px; letter-spacing: 0.3px; }
td { padding: 7px 8px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
tr:last-child td { border-bottom: none; }
.badge { display: inline-block; padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
.badge-good { background: #d1fae5; color: #065f46; }
.badge-bad  { background: #fee2e2; color: #991b1b; }
.badge-warn { background: #fef3c7; color: #92400e; }
.badge-neut { background: #e5e7eb; color: #374151; }
.footer { text-align: center; color: #6b7280; font-size: 12px; padding: 20px; }
.footer a { color: #2563eb; text-decoration: none; }
.small { font-size: 11px; color: #6b7280; }
h3 { margin: 18px 0 6px; color: #1f4e78; font-size: 14px; border-bottom: 1px solid #e5e7eb; padding-bottom: 4px; }
.pill-physical { background: #d1fae5; color: #065f46; padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
.pill-phone    { background: #fef3c7; color: #92400e; padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 600; }
.pill-none     { color: #9ca3af; font-size: 11px; }

.lead-summary { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-top: 8px; }
.lead-col { background: #f9fafb; border-radius: 8px; padding: 14px 16px; }
.lead-col .col-title { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; }
.lead-col-new   { border-top: 4px solid #2563eb; }
.lead-col-new   .col-title { color: #1e3a8a; }
.lead-col-resub { border-top: 4px solid #d97706; }
.lead-col-resub .col-title { color: #78350f; }
.lead-col-react { border-top: 4px solid #7c3aed; }
.lead-col-react .col-title { color: #5b21b6; }
.lead-col .big { font-size: 32px; font-weight: 800; color: #1f2937; line-height: 1; margin: 6px 0 12px; }
.lead-col table { font-size: 11px; }
.lead-col table td { padding: 4px 0; border-bottom: 1px dashed #e5e7eb; }
.lead-col table td:last-child { text-align: right; font-weight: 600; }
.lead-col table tr:last-child td { border-bottom: none; }
.booking-breakdown { font-size: 10px; color: #6b7280; padding-left: 8px; }
.cat-new   { background: #dbeafe; color: #1e3a8a; padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 700; }
.cat-resub { background: #fde68a; color: #78350f; padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 700; }
.cat-react { background: #e9d5ff; color: #5b21b6; padding: 2px 6px; border-radius: 10px; font-size: 10px; font-weight: 700; }
.row-booked { background: #ecfdf5 !important; }
.hxd-matrix th, .hxd-matrix td { text-align: center; padding: 5px 6px; }
.hxd-matrix th:first-child, .hxd-matrix td:first-child { text-align: left; }
.hxd-matrix td.zero { color: #d1d5db; }
.hxd-matrix tfoot td { font-weight: 700; background: #f3f4f6; }

.pipeline-cards { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 12px; margin-top: 8px; }
.pipeline-card { border-radius: 8px; padding: 14px 16px; }
.pipeline-card .pc-title { font-size: 11px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; }
.pipeline-card .pc-big { font-size: 32px; font-weight: 800; color: #1f2937; line-height: 1; margin: 6px 0 12px; }
.pipeline-card table { font-size: 11px; margin: 0; }
.pipeline-card td { padding: 4px 0; border-bottom: 1px dashed #e5e7eb; }
.pipeline-card td:last-child { text-align: right; font-weight: 600; }
.pipeline-card tr:last-child td { border-bottom: none; }

.funnel-box { background: #f9fafb; border-radius: 8px; padding: 14px 18px; }
.funnel-row { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-top: 1px solid #e5e7eb; }
.funnel-row:first-of-type { border-top: none; }
.funnel-badge { font-weight: 700; font-size: 11px; padding: 6px 10px; border-radius: 8px; min-width: 140px; text-align: center; }
.funnel-badge.active { background: #dbeafe; color: #1e3a8a; }
.funnel-badge.inactive { background: #f3f4f6; color: #6b7280; }
</style>`;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "\"": "&quot;",
  "'": "&#39;",
}[c]));

// Robust clock formatter. Accepts ISO strings, "HH:mm", "h:mm AM", millis,
// Date objects. Returns "—" if it can't make sense of the input.
function fmtClock(input) {
  if (input == null || input === "") return "—";
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return "—";
    return DateTime.fromJSDate(input).setZone(TZ).toFormat("h:mm a");
  }
  if (typeof input === "number") {
    const dt = DateTime.fromMillis(input).setZone(TZ);
    if (dt.isValid) return dt.toFormat("h:mm a");
    return "—";
  }
  const s = String(input).trim();
  // ISO 8601?
  const dtIso = DateTime.fromISO(s, { zone: TZ });
  if (dtIso.isValid) return dtIso.toFormat("h:mm a");
  // Already formatted like "7:25 AM"?
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(s)) return s;
  // 24-hour "HH:mm" or "HH:mm:ss"?
  const m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    const period = h >= 12 ? "PM" : "AM";
    const hr = ((h + 11) % 12) + 1;
    return `${hr}:${String(min).padStart(2, "0")} ${period}`;
  }
  return "—";
}

const fmtMinutes = (mins) => {
  if (mins == null || isNaN(mins)) return "—";
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

// v12/v14: defensive time extractor — first tries every common field, then
// falls back to scanning EVERY string property on c and c.raw for an
// ISO-shape or HH:MM:SS pattern. Always returns the most useful time it can.
function _extractCallTime(c) {
  if (!c) return "";
  // 1. Luxon DateTime (what enrichCalls sets as c.dt)
  if (c.dt && typeof c.dt.toFormat === "function" && c.dt.isValid) {
    return c.dt.toFormat("HH:mm:ss");
  }
  // 2. Common field names + format detection.
  function _tryString(s) {
    if (!s) return null;
    if (typeof s === "number") {
      // Plausible JS millis (year 2000+)?
      if (s > 946684800000 && s < 4102444800000) {
        const dt = DateTime.fromMillis(s).setZone(TZ);
        if (dt.isValid) return dt.toFormat("HH:mm:ss");
      }
      return null;
    }
    const str = String(s);
    const iso = str.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (iso) {
      const dt = DateTime.fromISO(str.replace(" ", "T"), { zone: "utc" }).setZone(TZ);
      if (dt.isValid) return dt.toFormat("HH:mm:ss");
    }
    const hms = str.match(/^(\d{2}):(\d{2}):(\d{2})$/);
    if (hms) return `${hms[1]}:${hms[2]}:${hms[3]}`;
    return null;
  }
  // 3. Brute-force scan of every string/number prop on c and c.raw.
  function _scanObj(obj, depth = 0) {
    if (!obj || typeof obj !== "object" || depth > 2) return null;
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (typeof v === "string" || typeof v === "number") {
        const t = _tryString(v);
        if (t) return t;
      } else if (v && typeof v === "object" && depth < 2) {
        const t = _scanObj(v, depth + 1);
        if (t) return t;
      }
    }
    return null;
  }
  const found = _scanObj(c);
  if (found) return found;
  // 4. Last resort: c.hour → "HH:00"
  if (typeof c.hour === "number") return `${String(c.hour).padStart(2, "0")}:00`;
  return "";
}

// Coerce statusFlag from whatever shape Hubstaff returns into a known code.
function coerceStatusFlag(raw) {
  if (raw == null) return "no_data";
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    return raw.code || raw.type || raw.status || raw.value || "no_data";
  }
  return "no_data";
}

function statusBadgeFor(code) {
  if (code === "ok" || code === "on_track") {
    return '<span class="badge badge-good">✓ on track</span>';
  }
  if (code === "on_shift") {
    return '<span class="badge badge-good">✓ on shift</span>';
  }
  if (code === "no_data") {
    return '<span class="badge badge-warn">no Hubstaff yet</span>';
  }
  const labelMap = {
    early_out: "❌ Early Out",
    late_in: "❌ Late In",
    hours_short: "❌ Hours short",
    break_over: "❌ Break over",
  };
  const label = labelMap[code] || ("❌ " + esc(String(code)));
  return `<span class="badge badge-bad">${label}</span>`;
}

// =====================================================================
// renderHubstaffSection — Section 1.
// v4: removed red-flags list rendering entirely (per Alex). Made clock/status
// parsing defensive so the columns aren't blank or "[object Object]".
// v5: Schedule + Status are now COMPUTED from EMPLOYEES + clock data when the
// upstream Hubstaff section builder doesn't set them, so Alex sees real
// "8:00 AM – 9:00 PM" schedules and "✓ on track" badges for employees with
// data instead of permanent "NO HUBSTAFF YET".
// =====================================================================

// Helpers for v5 status computation
function _hhmmToMin(s) {
  const m = String(s || "").match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
function _fmtTimeRange(start, end) {
  function fmt(hhmm) {
    if (!hhmm) return "";
    const [h, m] = String(hhmm).split(":").map(Number);
    const period = h >= 12 ? "PM" : "AM";
    const hr = ((h + 11) % 12) + 1;
    return `${hr}:${String(m || 0).padStart(2, "0")} ${period}`;
  }
  return `${fmt(start)} – ${fmt(end)}`;
}
function _clockMin(input) {
  if (input == null || input === "") return null;
  if (input instanceof Date) return input.getHours() * 60 + input.getMinutes();
  if (typeof input === "number") {
    const dt = DateTime.fromMillis(input).setZone(TZ);
    return dt.isValid ? dt.hour * 60 + dt.minute : null;
  }
  const s = String(input).trim();
  const dt = DateTime.fromISO(s, { zone: TZ });
  if (dt.isValid) return dt.hour * 60 + dt.minute;
  const m12 = s.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (m12) {
    let h = Number(m12[1]) % 12;
    if (/PM/i.test(m12[3])) h += 12;
    return h * 60 + Number(m12[2]);
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return Number(m24[1]) * 60 + Number(m24[2]);
  return null;
}

export function renderHubstaffSection(hub, opts = {}) {
  const generatedAt = opts.generatedAt
    ? (typeof opts.generatedAt === "string"
        ? DateTime.fromISO(opts.generatedAt, { zone: TZ })
        : opts.generatedAt)
    : DateTime.now().setZone(TZ);

  const perEmployee = hub?.perEmployee || [];
  const rows = perEmployee.map((emp) => {
    // Look up EMPLOYEES record by name (case-insensitive first name match).
    const empRec = EMPLOYEES.find((e) =>
      String(e.name || "").toLowerCase() === String(emp.name || "").toLowerCase() ||
      String(e.fullName || "").toLowerCase() === String(emp.name || "").toLowerCase()
    );
    const shift = empRec ? expectedShiftFor(empRec, generatedAt) : null;
    const role = emp.role || empRec?.role || "";

    // Compute scheduleText from EMPLOYEES if upstream didn't provide one.
    let scheduleText = emp.scheduleText;
    let scheduleSummary = emp.scheduleSummary;
    if (!scheduleText && shift) {
      scheduleText = _fmtTimeRange(shift.start, shift.end);
      const startMin = _hhmmToMin(shift.start);
      const endMin = _hhmmToMin(shift.end);
      const brk = empRec?.breakMinutesPerShift || 0;
      if (startMin != null && endMin != null) {
        const totalH = (endMin - startMin) / 60;
        scheduleSummary = `${totalH.toFixed(0)}h paid · ${brk} min break`;
      }
    }
    if (!scheduleText && empRec && !shift) {
      scheduleText = "off";
    }

    // Try common Hubstaff field names for clock-in/out.
    const clockIn  = emp.clockIn  ?? emp.clock_in  ?? emp.firstStart ?? emp.first_start ?? emp.startedAt ?? emp.started_at;
    const clockOut = emp.clockOut ?? emp.clock_out ?? emp.lastStop   ?? emp.last_stop   ?? emp.stoppedAt ?? emp.stopped_at;

    // Compute status code:
    //  - If upstream provided a non-"no_data" string code, use it.
    //  - Else compute from clock vs scheduled (matches mockup rule: ✓ on track
    //    only when none of late_in, early_out, hours_short, break_over fire).
    // v9: if the shift hasn't ENDED yet (i.e., the report is firing mid-shift
    // like the 12 PM morning snapshot), don't flag Early Out or Hours Short —
    // the "clock out" we see is just last-activity timestamp, not a real
    // clock-out. Show "✓ On shift" instead.
    let code = coerceStatusFlag(emp.statusFlag);
    const nowMin = generatedAt.hour * 60 + generatedAt.minute;
    if (code === "no_data" && clockIn != null && shift) {
      const ci = _clockMin(clockIn);
      const co = _clockMin(clockOut);
      const startMin = _hhmmToMin(shift.start);
      const endMin = _hhmmToMin(shift.end);
      const brkBudget = empRec?.breakMinutesPerShift ?? 0;
      const shiftInProgress = endMin != null && nowMin < endMin;
      const lateIn = ci != null && startMin != null && ci > startMin;
      const earlyOut = !shiftInProgress && co != null && endMin != null && co < endMin;
      const breakOver = emp.breakMinutes != null && emp.breakMinutes > brkBudget;
      const scheduledMin = startMin != null && endMin != null ? endMin - startMin - brkBudget : null;
      const hoursShort = !shiftInProgress && scheduledMin != null && emp.workedMinutes != null && emp.workedMinutes < scheduledMin * 0.95;
      if (lateIn) code = "late_in";
      else if (earlyOut) code = "early_out";
      else if (breakOver) code = "break_over";
      else if (hoursShort) code = "hours_short";
      else if (shiftInProgress) code = "on_shift";
      else code = "ok";
    }
    const statusBadge = statusBadgeFor(code);

    return `<tr>
      <td><b>${esc(emp.name)}</b><br><span class="small">${esc(role)}</span></td>
      <td>${esc(scheduleText || "")}<br><span class="small">${esc(scheduleSummary || "")}</span></td>
      <td>${fmtClock(clockIn)}</td>
      <td>${fmtClock(clockOut)}</td>
      <td><b>${fmtMinutes(emp.workedMinutes)}</b></td>
      <td>${fmtMinutes(emp.breakMinutes)}</td>
      <td>${emp.activityPct != null ? `${emp.activityPct}%` : "—"}</td>
      <td>${statusBadge}</td>
    </tr>`;
  }).join("");

  // Day-total table — pay = min(workedMinutes, scheduledMinutes) × payRate.
  // We recompute from scratch using EMPLOYEES + the actual schedule for the
  // report's date so payroll isn't sensitive to whatever the upstream
  // "totalsByEmployee" object provides.
  const dayTotalEntries = perEmployee
    .map((emp) => {
      const empRec = EMPLOYEES.find((e) =>
        String(e.name || "").toLowerCase() === String(emp.name || "").toLowerCase() ||
        String(e.fullName || "").toLowerCase() === String(emp.name || "").toLowerCase()
      );
      if (!empRec) return null;
      // Only include employees that are scheduled to work this day AND have
      // some clock data. Otherwise they don't appear in payroll.
      const shift = expectedShiftFor(empRec, generatedAt);
      if (!shift) return null;
      const startMin = _hhmmToMin(shift.start);
      const endMin = _hhmmToMin(shift.end);
      const brkBudget = empRec.breakMinutesPerShift ?? 0;
      const scheduledMin = startMin != null && endMin != null
        ? endMin - startMin - brkBudget
        : null;
      const workedMin = emp.workedMinutes;
      let paidMin = null;
      if (scheduledMin != null && workedMin != null) {
        paidMin = Math.min(workedMin, scheduledMin);
      } else if (scheduledMin != null) {
        paidMin = 0;
      }
      const payRate = empRec.payRate ?? 0;
      const cost = paidMin != null ? (paidMin / 60) * payRate : 0;
      return {
        name: emp.name,
        scheduledMin,
        workedMin,
        paidMin,
        payRate,
        cost,
      };
    })
    .filter(Boolean);
  const totalScheduled = dayTotalEntries.reduce((s, r) => s + (r.scheduledMin || 0), 0);
  const totalPaid = dayTotalEntries.reduce((s, r) => s + (r.paidMin || 0), 0);
  const totalCost = dayTotalEntries.reduce((s, r) => s + (r.cost || 0), 0);
  const dayTotalRows = dayTotalEntries.map((r) => {
    const paidNote = r.workedMin != null && r.scheduledMin != null && r.workedMin > r.scheduledMin
      ? ` <span class="small">(actual ${fmtMinutes(r.workedMin)} capped)</span>`
      : "";
    return `<tr>
      <td>${esc(r.name)}</td>
      <td>${fmtMinutes(r.scheduledMin)}</td>
      <td>${fmtMinutes(r.paidMin)}${paidNote}</td>
      <td>${r.payRate ? `$${r.payRate}/hr` : ""}</td>
      <td>$${(r.cost || 0).toFixed(2)}</td>
    </tr>`;
  }).join("");
  // v11: skip Day Total on morning reports — irrelevant mid-shift.
  const dayTotalHtml = (opts.omitDayTotal || !dayTotalEntries.length) ? "" : `<h3>Day Total — paid hours only (capped at scheduled)</h3>
    <table>
      <thead><tr><th>Employee</th><th>Scheduled</th><th>Worked (paid)</th><th>Pay Rate</th><th>Cost</th></tr></thead>
      <tbody>
        ${dayTotalRows}
        <tr style="background:#f3f4f6;font-weight:bold"><td>TOTAL</td><td>${fmtMinutes(totalScheduled)}</td><td>${fmtMinutes(totalPaid)}</td><td></td><td>$${totalCost.toFixed(2)}</td></tr>
      </tbody>
    </table>
    <p class="small"><b>Pay formula:</b> <code>min(worked within shift, scheduled paid hours) × rate</code>. Time clocked outside the shift (before start, after end) doesn't count. Scheduled paid hours = shift length minus break budget.</p>`;

  // Footer summary — count on-track vs. exceptions (re-derived after compute)
  const computedCodes = perEmployee.map((emp) => {
    const empRec = EMPLOYEES.find((e) =>
      String(e.name || "").toLowerCase() === String(emp.name || "").toLowerCase() ||
      String(e.fullName || "").toLowerCase() === String(emp.name || "").toLowerCase()
    );
    const shift = empRec ? expectedShiftFor(empRec, generatedAt) : null;
    const clockIn = emp.clockIn ?? emp.clock_in ?? emp.firstStart ?? emp.first_start ?? emp.startedAt ?? emp.started_at;
    const clockOut = emp.clockOut ?? emp.clock_out ?? emp.lastStop ?? emp.last_stop ?? emp.stoppedAt ?? emp.stopped_at;
    let code = coerceStatusFlag(emp.statusFlag);
    const nowMin = generatedAt.hour * 60 + generatedAt.minute;
    if (code === "no_data" && clockIn != null && shift) {
      const ci = _clockMin(clockIn);
      const co = _clockMin(clockOut);
      const startMin = _hhmmToMin(shift.start);
      const endMin = _hhmmToMin(shift.end);
      const brkBudget = empRec?.breakMinutesPerShift ?? 0;
      const shiftInProgress = endMin != null && nowMin < endMin;
      const lateIn = ci != null && startMin != null && ci > startMin;
      const earlyOut = !shiftInProgress && co != null && endMin != null && co < endMin;
      const breakOver = emp.breakMinutes != null && emp.breakMinutes > brkBudget;
      const scheduledMin = startMin != null && endMin != null ? endMin - startMin - brkBudget : null;
      const hoursShort = !shiftInProgress && scheduledMin != null && emp.workedMinutes != null && emp.workedMinutes < scheduledMin * 0.95;
      if (lateIn) code = "late_in";
      else if (earlyOut) code = "early_out";
      else if (breakOver) code = "break_over";
      else if (hoursShort) code = "hours_short";
      else if (shiftInProgress) code = "on_shift";
      else code = "ok";
    }
    return code;
  });
  const onTrack = computedCodes.filter((c) => c === "ok" || c === "on_track" || c === "on_shift").length;
  const noData = computedCodes.filter((c) => c === "no_data").length;
  const offTrack = computedCodes.length - onTrack - noData;
  const summary = computedCodes.length
    ? `<b>Summary:</b> ${onTrack} on track · ${offTrack} flagged · ${noData} no Hubstaff data${opts.omitDayTotal ? "" : ` · day cost $${totalCost.toFixed(2)}`}.`
    : "<b>Summary:</b> no Hubstaff records for today yet.";

  return `<div class="section">
    <h2>Section 1 — Hubstaff (Hours &amp; Activity)</h2>
    <div class="subhead">Per-employee clock-in/out, worked-within-shift, activity %, and on-time status.</div>
    <table>
      <thead><tr><th>Employee</th><th>Schedule</th><th>Clock In</th><th>Clock Out</th><th>Worked (within shift)</th><th>Break</th><th>Activity</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="small" style="margin-top:8px">
      <b>Status rule:</b> ✓ on track only when none of these fire — late clock-in, early clock-out, hours-short, or break over budget.
      Early clock-in and late clock-out are <b>not</b> flagged.
    </p>
    ${dayTotalHtml}
    <div class="summary-footer">${summary}</div>
  </div>`;
}

// =====================================================================
// renderCallActivitySection — Section 2 (Call Activity Day Totals).
// v5: accepts excelData so we can show today's bookings (Physical/Phone) in
// the stat strip + summary footer, computed from the same source as Section 3.
// =====================================================================
export function renderCallActivitySection(dispatch, excelData) {
  // v9: prefer excelData.buckets / totals (= same source as Excel attachment
  // and Section 3). Falls back to dispatch.byDispatcher aggregation only if
  // excelData isn't available.
  const buckets = excelData?.buckets;
  const totals = excelData?.totals;
  let sum;
  if (buckets && totals) {
    sum = {
      total: totals.both || 0,
      real: buckets.real_call || 0,
      lt: buckets.live_transfer || 0,
      vm: 0, // not tracked in buckets — voicemail rolls into no_answer/failed bucketing
      attempt: (buckets.no_answer || 0) + (buckets.failed || 0) + (buckets.ringing || 0),
    };
  } else {
    const byD = dispatch?.byDispatcher || [];
    sum = byD.reduce((acc, d) => {
      acc.total += (d.real || 0) + (d.voicemail || 0) + (d.attempt || 0) + (d.liveTransfers || 0);
      acc.real += d.real || 0;
      acc.lt += d.liveTransfers || 0;
      acc.vm += d.voicemail || 0;
      acc.attempt += d.attempt || 0;
      return acc;
    }, { total: 0, real: 0, lt: 0, vm: 0, attempt: 0 });
  }

  const naPct = sum.total > 0 ? (sum.attempt / sum.total * 100).toFixed(1) : "0.0";

  // Booking counts from excelData rows (source of truth)
  let bookedTotal = 0, bookedPhys = 0, bookedPhone = 0;
  if (excelData) {
    const rows = [
      ...(excelData.newLeadRows || []),
      ...(excelData.newOppRows || []),
      ...(excelData.reactivatedRows || []),
    ];
    for (const r of rows) {
      if (!r.bookedToday) continue;
      bookedTotal++;
      const s = r.finalStage || r.stage || "";
      if (s === "Appt. Booked") bookedPhys++;
      if (s === "Over Phone Booked") bookedPhone++;
    }
  }

  // v7: Real Calls detail table — every real call today with customer, category,
  // source, time, duration, origin stage, booked status.
  const calls = excelData?.calls || [];
  // Build lookup: contact_id → { row, category }
  const rowByContact = new Map();
  if (excelData) {
    for (const r of (excelData.newLeadRows || [])) {
      const cid = r._id || r.contactId || r.contact_id;
      if (cid) rowByContact.set(cid, { row: r, cat: "NEW", origin: "New Lead In" });
    }
    for (const r of (excelData.newOppRows || [])) {
      const cid = r._id || r.contactId || r.contact_id;
      if (cid) rowByContact.set(cid, { row: r, cat: "RESUB", origin: "New Lead In (reset)" });
    }
    for (const r of (excelData.reactivatedRows || [])) {
      const cid = r._id || r.contactId || r.contact_id;
      if (cid) rowByContact.set(cid, { row: r, cat: "REACT", origin: r.stage || "(unknown)" });
    }
  }
  // Real calls = bucket "real_call" OR "live_transfer" OR durationSec >= 70.
  const realCalls = calls.filter((c) => {
    if (c.bucket === "real_call" || c.bucket === "live_transfer") return true;
    if (Number(c.durationSec || 0) >= 70) return true;
    return false;
  });
  // Sort by extracted call time (defensive against missing c.dt).
  realCalls.sort((a, b) => {
    const ta = _extractCallTime(a) || "99:99:99";
    const tb = _extractCallTime(b) || "99:99:99";
    return ta.localeCompare(tb);
  });
  function _hhmmssFromCall(c) {
    return _extractCallTime(c) || "—";
  }
  const realCallRows = realCalls.map((c) => {
    const cid = c.raw?.contact_id;
    const match = cid ? rowByContact.get(cid) : null;
    // v11/v14: enrichCalls() sets c.contactName when contactMap has the contact;
    // fall back to lead row, phone, or "(unknown contact)" so we never show "—".
    const customer = c.contactName || match?.row?.leadName || match?.row?.name || c.phone || c.raw?.phone || "(unknown contact)";
    const catPill = !match
      ? "—"
      : match.cat === "NEW" ? '<span class="cat-new">NEW</span>'
      : match.cat === "RESUB" ? '<span class="cat-resub">RESUB</span>'
      : '<span class="cat-react">REACT</span>';
    const source = match?.row?.leadSource || match?.row?.source || "—";
    const time = _hhmmssFromCall(c);
    const duration = c.durationFmt || (c.durationSec ? fmtDuration(c.durationSec) : "—");
    const origin = match?.origin || "—";
    const dispatcher = c.dispatcher || "—";
    let bookedCell = "—";
    if (c.bucket === "live_transfer") bookedCell = '<span class="badge badge-warn">Live Transfer</span>';
    if (match?.row?.bookedToday) {
      const stage = match.row.finalStage || match.row.stage || "";
      if (stage === "Appt. Booked") bookedCell = '<span class="pill-physical">Physical</span>';
      else if (stage === "Over Phone Booked") bookedCell = '<span class="pill-phone">Phone Booked</span>';
    }
    return `<tr>
      <td>${esc(customer)}</td>
      <td>${catPill}</td>
      <td>${esc(source)}</td>
      <td>${time}</td>
      <td>${esc(duration)}</td>
      <td>${esc(origin)}</td>
      <td>${esc(dispatcher)}</td>
      <td>${bookedCell}</td>
    </tr>`;
  }).join("");

  const realCallsTable = realCalls.length === 0
    ? '<p class="small" style="margin-top:12px">No real calls placed today (REAL_CALL_THRESHOLD = 70s).</p>'
    : `<h3 style="margin-top:18px">Real Calls — every conversation ≥70s today</h3>
       <table>
         <thead><tr><th>Customer</th><th>Cat</th><th>Source</th><th>Time</th><th>Duration</th><th>Origin Stage</th><th>Dispatcher</th><th>Booked</th></tr></thead>
         <tbody>${realCallRows}</tbody>
       </table>
       <p class="small" style="margin-top:4px">Each row is one real conversation. <b>Origin Stage</b> = where the lead was BEFORE this conversation (so you can see which pipeline stages are producing bookings).</p>`;

  return `<div class="section" style="padding:14px 24px">
    <h2 style="font-size:16px">Section 2 — Call Activity (Day Totals)</h2>
    <div style="display:flex;flex-wrap:wrap;gap:0;align-items:baseline;font-size:13px;margin-top:6px;color:#1f2937;line-height:1.7">
      <span><span style="color:#6b7280">Total:</span> <b style="font-size:16px;color:#1f4e78">${sum.total}</b></span>
      <span style="color:#d1d5db;margin:0 12px">|</span>
      <span><span style="color:#6b7280">Real:</span> <b style="color:#1f4e78">${sum.real}</b></span>
      <span style="color:#d1d5db;margin:0 12px">|</span>
      <span><span style="color:#6b7280">Live Transfers:</span> <b style="color:#1f4e78">${sum.lt}</b></span>
      <span style="color:#d1d5db;margin:0 12px">|</span>
      <span><span style="color:#6b7280">No Answer / Failed:</span> <b style="color:#1f4e78">${sum.attempt}</b> <span class="small">${naPct}%</span></span>
      <span style="color:#d1d5db;margin:0 12px">|</span>
      <span><span style="color:#6b7280">Booked:</span> <b style="color:#1f4e78">${bookedTotal}</b> <span class="small">(${bookedPhys} <span class="pill-physical">Physical</span> · ${bookedPhone} <span class="pill-phone">Phone</span>)</span></span>
      <span style="color:#d1d5db;margin:0 12px">|</span>
      <span class="small">REAL_CALL_THRESHOLD = 70s</span>
    </div>
    ${realCallsTable}
    <div class="summary-footer"><b>Summary:</b> ${sum.total} total calls · ${sum.real} real conversations · ${sum.lt} live transfers · ${sum.attempt} no-answer/failed · <b>${bookedTotal} bookings</b> (${bookedPhys} <span class="pill-physical">Physical</span> · ${bookedPhone} <span class="pill-phone">Phone</span>).</div>
  </div>`;
}

// =====================================================================
// Helpers shared by Sections 3 / 6
// =====================================================================
function parseDurFmt(s) {
  if (!s) return 0;
  const m = String(s).match(/(?:(\d+)m)?\s*(\d+)s/);
  if (!m) return 0;
  return (Number(m[1] || 0) * 60) + Number(m[2] || 0);
}
function statsForRows(rows, opts = {}) {
  const isReact = !!opts.isReact;
  let total = rows.length;
  let le1 = 0, le3 = 0, gt3 = 0, neverCalled = 0;
  let realCalls = 0, liveTransfers = 0;
  let booked = 0, bookedPhysical = 0, bookedPhone = 0;
  for (const r of rows) {
    if (!isReact) {
      const respSec = Number(r._respSec || 0);
      const hasResp = r._respSec != null;
      const never = r.responseTime === "Never" || !hasResp;
      if (never) neverCalled++;
      else if (respSec <= 60) le1++;
      else if (respSec <= 180) le3++;
      else gt3++;
    }
    const dur = Number(r.longestCallSec || parseDurFmt(r.longestCallDuration || r.durationFmt));
    if (dur >= 70) realCalls++;
    if (r.activity === "Live Transfer" || r.hasLiveTransfer || r.liveTransfers > 0) liveTransfers++;
    if (r.bookedToday) {
      booked++;
      const stage = r.finalStage || r.stage || "";
      if (stage === "Appt. Booked") bookedPhysical++;
      if (stage === "Over Phone Booked") bookedPhone++;
    }
  }
  return { total, le1, le3, gt3, neverCalled, realCalls, liveTransfers, booked, bookedPhysical, bookedPhone };
}
function pct(n, d) {
  if (!d) return "0%";
  return Math.round((n / d) * 100) + "%";
}

// =====================================================================
// renderLeadActivitySection — Section 3.
// =====================================================================
export function renderLeadActivitySection(excelData, opts = {}) {
  if (!excelData) return "";
  const { newLeadRows = [], newOppRows = [], reactivatedRows = [], calls = [] } = excelData;
  const generatedAt = opts.generatedAt
    ? (typeof opts.generatedAt === "string"
        ? DateTime.fromISO(opts.generatedAt, { zone: TZ })
        : opts.generatedAt)
    : DateTime.now().setZone(TZ);
  const newS = statsForRows(newLeadRows);
  const resubS = statsForRows(newOppRows);
  const reactS = statsForRows(reactivatedRows, { isReact: true });

  // Enrich each lead row from the calls array — fields that buildNewLeads
  // doesn't always populate (firstCallTime, totalDuration, attempts, hadRealCall).
  // v11: use the ACTUAL fields enrichCalls() sets — c.raw.contact_id for
  // matching, c.dt (Luxon DateTime) for the timestamp.
  function _enrichFromCalls(row, generatedAt) {
    const cid = row._id || row.contactId || row.contact_id || row.id;
    if (!cid) return { firstCallTime: "", hadRealCall: false, totalDurationFmt: "", attempts: 0, inProgress: false };
    const mine = calls.filter((c) => (c.raw && c.raw.contact_id) === cid);
    // Decide "in progress": came in within 30 min of generatedAt AND no calls yet.
    let inProgress = false;
    if (mine.length === 0 && generatedAt && (row.cameIn || row.activityTime)) {
      try {
        const cameStr = row.cameIn || row.activityTime;
        const m = String(cameStr).match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/) ||
                  String(cameStr).match(/^(\d{2}):(\d{2}):(\d{2})/);
        if (m) {
          // best-effort minute parsing
          const hh = Number(m[m.length - 3]);
          const mm = Number(m[m.length - 2]);
          const cameMin = hh * 60 + mm;
          const nowMin = generatedAt.hour * 60 + generatedAt.minute;
          if (nowMin - cameMin >= 0 && nowMin - cameMin <= 30) inProgress = true;
        }
      } catch {}
    }
    if (mine.length === 0) return { firstCallTime: "", hadRealCall: false, totalDurationFmt: "", attempts: 0, inProgress };
    // Sort by extracted time (HH:mm:ss) ascending so first[0] is earliest.
    mine.sort((a, b) => {
      const ta = _extractCallTime(a) || "99:99:99";
      const tb = _extractCallTime(b) || "99:99:99";
      return ta.localeCompare(tb);
    });
    const first = mine[0];
    const firstCallTime = _extractCallTime(first);
    const totalSec = mine.reduce((s, c) => s + (Number(c.durationSec) || 0), 0);
    const hadRealCall = mine.some((c) => c.bucket === "real_call" || c.bucket === "live_transfer" || (Number(c.durationSec || 0) >= 70));
    function fmtSec(sec) {
      if (sec < 60) return sec + "s";
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      return s ? `${m}m ${s}s` : `${m}m`;
    }
    return {
      firstCallTime,
      hadRealCall,
      totalDurationFmt: totalSec > 0 ? fmtSec(totalSec) : "",
      attempts: mine.length,
      inProgress: false,
    };
  }

  // v13: TEMPORARY debug dump — first 3 calls' keys + sample values so we can
  // see the actual field names without server-log access. Embedded as an
  // HTML comment so it doesn't render but shows in View-Source.
  function _safeDump(obj) {
    try {
      return JSON.stringify(obj, (k, v) => {
        if (v && typeof v === "object" && v.constructor && v.constructor.name === "DateTime") {
          return { __DateTime: true, iso: v.isValid ? v.toISO() : null, valid: v.isValid, hour: v.hour };
        }
        return v;
      });
    } catch (e) { return "DUMP_ERR:" + e.message; }
  }
  const debugDump = calls.slice(0, 3).map((c, i) => `CALL[${i}] keys=${Object.keys(c).join(",")} sample=${_safeDump(c).substring(0, 1500)}`).join("\n\n");

  function colTable(s, isReact) {
    const respRows = isReact ? "" : `
        <tr><td>≤ 1 min</td><td>${s.le1} (${pct(s.le1, s.total)})</td></tr>
        <tr><td>≤ 3 min</td><td>${s.le1 + s.le3} (${pct(s.le1 + s.le3, s.total)})</td></tr>
        <tr><td>&gt; 3 min</td><td>${s.gt3} (${pct(s.gt3, s.total)})</td></tr>
        <tr><td>Never called</td><td>${s.neverCalled}</td></tr>`;
    const bookPct = s.realCalls > 0 ? pct(s.booked, s.realCalls) : "0%";
    // v20.5: top-line conversion rate — bookings / total leads in this category.
    const convPct = s.total > 0 ? pct(s.booked, s.total) : "0%";
    return `<table>
      ${respRows}
      <tr><td>Real Calls (≥70s)</td><td>${s.realCalls}</td></tr>
      <tr><td>Live Transfers</td><td>${s.liveTransfers}</td></tr>
      <tr><td><b>Booked Today</b></td><td><b>${s.booked}</b></td></tr>
      <tr><td colspan="2" class="booking-breakdown">└ ${s.bookedPhysical} <span class="pill-physical">Physical</span> &nbsp; ${s.bookedPhone} <span class="pill-phone">Phone Booking</span></td></tr>
      <tr><td><b>Conversion Rate</b></td><td><b>${convPct}</b> <span class="small">(${s.booked} of ${s.total})</span></td></tr>
      <tr><td><b>Real → Book</b></td><td><b>${bookPct}</b> <span class="small">(${s.booked} of ${s.realCalls})</span></td></tr>
    </table>`;
  }

  // Detail table — sort ALL rows (including REACT) by time-of-day ascending.
  // NEW/RESUB have cameIn = "yyyy-LL-dd HH:mm:ss"; REACT has activityTime =
  // "HH:mm:ss". Extract just HH:mm:ss for a fair comparison.
  function _timeKey(r) {
    const s = r.cameIn || r.activityTime || "";
    const m = String(s).match(/(\d{2}):(\d{2}):(\d{2})/);
    return m ? `${m[1]}:${m[2]}:${m[3]}` : "99:99:99";
  }
  const allRows = [
    ...newLeadRows.map((r) => ({ cat: "NEW", row: r })),
    ...newOppRows.map((r) => ({ cat: "RESUB", row: r })),
    ...reactivatedRows.map((r) => ({ cat: "REACT", row: r })),
  ];
  allRows.sort((a, b) => {
    const ka = _timeKey(a.row);
    const kb = _timeKey(b.row);
    return ka < kb ? -1 : 1;
  });
  const detailRows = allRows.map(({ cat, row }, idx) => {
    const catPill = cat === "NEW" ? '<span class="cat-new">NEW</span>'
                  : cat === "RESUB" ? '<span class="cat-resub">RESUB</span>'
                  : '<span class="cat-react">REACT</span>';
    const enriched = _enrichFromCalls(row, generatedAt);
    const name = row.leadName || row.name || "(unknown)";
    const source = row.leadSource || row.source || "";
    const cameIn = row.cameIn || row.activityTime || "";
    // First call: prefer the enriched (computed from calls) timestamp.
    const inProgressLabel = '<span class="small" style="color:#92400e">in progress</span>';
    const firstCall = enriched.firstCallTime
      || (row.firstCallTime ? String(row.firstCallTime).slice(0, 8) : (row.activityTime || (enriched.inProgress ? inProgressLabel : "—")));
    const resp = row.responseTime || (enriched.inProgress ? "in progress" : "—");
    // Real Call: longest single call ≥70s if available, else "—".
    const realCall = row.longestCallDuration || row.durationFmt
      || (enriched.hadRealCall ? (enriched.totalDurationFmt || "≥70s") : (enriched.inProgress ? inProgressLabel : "—"));
    // Total duration of ALL calls placed to this contact today (new column).
    const totalDur = enriched.totalDurationFmt || (enriched.inProgress ? inProgressLabel : "—");
    const disp = row.firstCaller || row.dispatcher || row.longestCallDispatcher || "—";
    // Origin Stage: where the lead was BEFORE today. NEW/RESUB → "New Lead In".
    // REACT → row.stage (where they were when we re-engaged them).
    const originStage = cat === "NEW" ? "New Lead In"
                      : cat === "RESUB" ? "New Lead In (reset)"
                      : (row.stage || "(unknown)");
    const stageForBooking = row.finalStage || row.stage || "";
    const isPhysical = row.bookedToday && stageForBooking === "Appt. Booked";
    const isPhone = row.bookedToday && stageForBooking === "Over Phone Booked";
    const booked = isPhysical
      ? '<span class="pill-physical">Physical</span>'
      : isPhone
      ? '<span class="pill-phone">Phone Booked</span>'
      : (row.bookedToday ? '<span class="pill-physical">Booked</span>' : "—");
    // Attempts: prefer enriched (count of all calls to this contact today).
    const attempts = enriched.attempts || row.attempts || row.callCount || (enriched.inProgress ? "0 (in progress)" : "0");
    // Booking Method — v14: compute inline from this contact's calls so the
    // value always agrees with Section 6 funnel.
    const cidForMethod = row._id || row.contactId || row.contact_id || row.id;
    let bookingMethod = "—";
    if (row.bookedToday) {
      const _myCalls = (excelData.calls || []).filter((c) => (c.raw && c.raw.contact_id) === cidForMethod);
      if (_myCalls.some((c) => c.bucket === "live_transfer")) bookingMethod = '<span class="badge badge-warn">Live Transfer</span>';
      else if (_myCalls.some((c) => c.bucket === "real_call" || (Number(c.durationSec || 0) >= 70))) bookingMethod = '<span class="badge badge-good">Call</span>';
      else bookingMethod = '<span class="badge badge-bad" style="background:#fee2e2;color:#991b1b">SMS</span>';
    }
    const lt = (row.activity === "Live Transfer" || row.hasLiveTransfer || row.liveTransfers) ? "Yes" : "";
    // Row color: green for Physical, yellow for Phone Booked, default for the rest.
    const rowStyle = isPhysical
      ? ' style="background:#ecfdf5"'
      : isPhone
      ? ' style="background:#fef9c3"'
      : "";
    // (rowStyle is used in the <tr> tag below; legacy rowClass var removed.)
    const respSec = Number(row._respSec || 0);
    let respBadge = `<span class="small">${esc(resp)}</span>`;
    if (cat === "REACT") {
      // v20.4 — REACT response time = elapsed between customer's first inbound
      // event today and dispatcher's first outbound response.
      //   row._respSec === null      → no inbound event today (dispatcher cold-called)
      //   row._respSec === 0         → answered live on inbound (no wait)
      //   row._respSec > 0           → real measured wait
      //   row.responseBucket "Pending" → inbound seen but no response yet
      if (row._respSec === 0) {
        respBadge = `<span class="badge badge-good">Live</span>`;
      } else if (typeof row._respSec === "number" && row._respSec > 0) {
        if (row._respSec <= 60) respBadge = `<span class="badge badge-good">≤ 1 min</span>`;
        else if (row._respSec <= 180) respBadge = `<span class="badge badge-warn">≤ 3 min</span>`;
        else if (row._respSec <= 300) respBadge = `<span class="badge badge-warn">≤ 5 min</span>`;
        else respBadge = `<span class="badge badge-bad">&gt; 5 min</span>`;
      } else if (row.responseBucket === "Pending") {
        respBadge = `<span class="badge badge-bad">Pending</span>`;
      } else {
        respBadge = `<span class="small">—</span>`;
      }
    } else if (respSec > 0) {
      // Note: respSec for RESUB rows is unreliable until the upstream excel-report
      // fix lands — it's measured from the original lead date rather than the
      // resubmission timestamp. Negative / huge values fall through to "—".
      if (respSec <= 60) respBadge = `<span class="badge badge-good">≤ 1 min</span>`;
      else if (respSec <= 180) respBadge = `<span class="badge badge-warn">≤ 3 min</span>`;
      else if (respSec <= 300) respBadge = `<span class="badge badge-warn">≤ 5 min</span>`;
      else respBadge = `<span class="badge badge-bad">&gt; 5 min</span>`;
    } else if (respSec <= 0) {
      // Negative or zero — likely the resub bug. Show dash until fixed upstream.
      respBadge = `<span class="small">—</span>`;
    }
    return `<tr${rowStyle}>
      <td>${catPill}</td>
      <td>${idx + 1}</td>
      <td>${esc(name)}</td>
      <td>${esc(source)}</td>
      <td>${esc(String(cameIn).slice(11, 19) || String(cameIn).slice(0, 8))}</td>
      <td>${firstCall.includes('<') ? firstCall : esc(String(firstCall).slice(0, 8))}</td>
      <td>${respBadge}</td>
      <td>${realCall.includes && realCall.includes('<') ? realCall : esc(realCall)}</td>
      <td>${totalDur.includes && totalDur.includes('<') ? totalDur : esc(totalDur)}</td>
      <td>${esc(disp)}</td>
      <td>${lt}</td>
      <td>${esc(originStage)}</td>
      <td>${booked}</td>
      <td>${bookingMethod}</td>
      <td>${esc(String(attempts))}</td>
    </tr>`;
  }).join("");

  const totalBooked = newS.booked + resubS.booked + reactS.booked;
  const totalPhys = newS.bookedPhysical + resubS.bookedPhysical + reactS.bookedPhysical;
  const totalPhone = newS.bookedPhone + resubS.bookedPhone + reactS.bookedPhone;

  return `<div class="section">
    <h2>Section 3 — Lead Activity</h2>
    <div class="subhead">New leads, resubmissions, and reactivated — side by side</div>
    <!-- v6: table-based 3-col layout for email-client compatibility (CSS grid
         is stripped by Gmail/Outlook on some configs). -->
    <table style="width:100%;border-collapse:separate;border-spacing:12px 0;margin:8px 0;border:none">
      <tr>
        <td style="width:33.33%;vertical-align:top;padding:0;border:none">
          <div class="lead-col lead-col-new">
            <div class="col-title">New Leads</div>
            <div class="big">${newS.total}</div>
            ${colTable(newS, false)}
          </div>
        </td>
        <td style="width:33.33%;vertical-align:top;padding:0;border:none">
          <div class="lead-col lead-col-resub">
            <div class="col-title">Resubmission</div>
            <div class="big">${resubS.total}</div>
            ${colTable(resubS, false)}
          </div>
        </td>
        <td style="width:33.33%;vertical-align:top;padding:0;border:none">
          <div class="lead-col lead-col-react">
            <div class="col-title">Reactivated</div>
            <div class="big">${reactS.total}</div>
            ${colTable(reactS, true)}
          </div>
        </td>
      </tr>
    </table>
    <h3 style="margin-top:24px">Detail — all leads with activity today</h3>
    <table>
      <thead><tr><th>Cat</th><th>#</th><th>Lead</th><th>Source</th><th>Came In</th><th>First Call</th><th>Resp</th><th>Real Call</th><th>Total Call Time</th><th>1st Disp</th><th>LT</th><th>Origin Stage</th><th>Booked</th><th>Booking Method</th><th>Attempts</th></tr></thead>
      <tbody>${detailRows || '<tr><td colspan="15" class="small">No lead activity today.</td></tr>'}</tbody>
    </table>
    <p class="small" style="margin-top:12px">
      <b>Legend:</b> <span class="cat-new">NEW</span> first-time lead today · <span class="cat-resub">RESUB</span> resubmission of an older contact · <span class="cat-react">REACT</span> old lead we got on the phone (no resubmission).
      <b>Resp</b> = time from "Came In" to "First Call". <b>Real Call</b> = longest call ≥70s today.
    </p>
    <div class="summary-footer"><b>Summary:</b> ${newLeadRows.length} new + ${newOppRows.length} resub + ${reactivatedRows.length} reactivated = ${totalBooked} bookings today (${totalPhys} <span class="pill-physical">Physical</span> · ${totalPhone} <span class="pill-phone">Phone Booking</span>).</div>
  </div>`;
}

// =====================================================================
// renderDispatcherPerformanceSection — Section 4 (split out from the old
// renderDispatcherSection so order is 1→2→3→4→5→6).
// v5: accepts excelData so it can attribute bookings to dispatchers from the
// same source of truth as Sections 2, 3, 5, 6 (no more "0 0 0" booking rows).
// Voicemail column dropped per Alex.
// =====================================================================
export function renderDispatcherPerformanceSection(dispatch, excelData) {
  const byD = dispatch?.byDispatcher || [];

  // Build per-dispatcher booking counters from excelData rows.
  // First-name match to be robust against last-name differences in dispatch.byDispatcher.
  const physByDisp = new Map();
  const phoneByDisp = new Map();
  function dispatcherKey(name) {
    if (!name) return null;
    return String(name).trim().split(/\s+/)[0].toLowerCase();
  }
  function bump(map, name) {
    const k = dispatcherKey(name);
    if (!k) return;
    map.set(k, (map.get(k) || 0) + 1);
  }
  if (excelData) {
    const allRows = [
      ...(excelData.newLeadRows || []),
      ...(excelData.newOppRows || []),
      ...(excelData.reactivatedRows || []),
    ];
    for (const r of allRows) {
      if (!r.bookedToday) continue;
      const disp = r.firstCaller || r.longestCallDispatcher || r.dispatcher || "";
      const stage = r.finalStage || r.stage || "";
      if (stage === "Appt. Booked") bump(physByDisp, disp);
      if (stage === "Over Phone Booked") bump(phoneByDisp, disp);
    }
  }
  // Per-dispatcher unique-contact counts from excelData.calls
  const uniqueByDisp = new Map();
  if (excelData?.calls) {
    for (const c of excelData.calls) {
      const k = dispatcherKey(c.dispatcher);
      if (!k) continue;
      if (!uniqueByDisp.has(k)) uniqueByDisp.set(k, new Set());
      const cid = c.raw?.contact_id;
      if (cid) uniqueByDisp.get(k).add(cid);
    }
  }

  let totals = { total: 0, real: 0, lt: 0, attempt: 0, phys: 0, phone: 0 };
  const rows = byD
    .filter((d) => String(d.name || "").toLowerCase() !== "inbound")
    .map((d) => {
      const totalCalls = (d.real || 0) + (d.voicemail || 0) + (d.attempt || 0) + (d.liveTransfers || 0);
      const pctReal = totalCalls > 0 ? `${(((d.real || 0) + (d.liveTransfers || 0)) / totalCalls * 100).toFixed(1)}%` : "—";
      const k = dispatcherKey(d.name);
      const uniqueContacts = (uniqueByDisp.get(k) || new Set()).size;
      // Avg / Contact = total calls placed by this dispatcher / unique contacts they touched.
      const avgPerContact = uniqueContacts > 0 ? (totalCalls / uniqueContacts) : null;
      let ratioCell = "—";
      if (avgPerContact != null && uniqueContacts >= 3) {
        const cls = avgPerContact >= 2 && avgPerContact <= 4 ? "badge-good" : avgPerContact < 2 ? "badge-bad" : "badge-warn";
        ratioCell = `<span class="badge ${cls}">${avgPerContact.toFixed(2)}</span>`;
      } else if (avgPerContact != null) {
        ratioCell = avgPerContact.toFixed(2);
      }
      const phys = physByDisp.get(k) ?? d.physBookings ?? 0;
      const phone = phoneByDisp.get(k) ?? d.phBookings ?? 0;
      totals.total += totalCalls;
      totals.real += d.real || 0;
      totals.lt += d.liveTransfers || 0;
      totals.attempt += (d.attempt || 0) + (d.voicemail || 0);
      totals.phys += phys;
      totals.phone += phone;
      // Trim role to friendly form (dispatcher / manager / training / office)
      return `<tr>
        <td><b>${esc(d.name)}</b><br><span class="small">${esc(d.role || "")}</span></td>
        <td>${totalCalls}</td>
        <td>${d.real || 0}</td>
        <td>${d.liveTransfers || 0}</td>
        <td>${(d.attempt || 0) + (d.voicemail || 0)}</td>
        <td>${uniqueContacts}</td>
        <td>${ratioCell}</td>
        <td>${pctReal}</td>
        <td>${phys ? `<b>${phys}</b> <span class="pill-physical">Physical</span>` : "0"}</td>
        <td>${phone ? `<b>${phone}</b> <span class="pill-phone">Phone Booking</span>` : "0"}</td>
      </tr>`;
    }).join("");

  return `<div class="section">
    <h2>Section 4 — Dispatcher Performance</h2>
    <div class="subhead">Per-dispatcher rollup with bookings broken out.</div>
    <table>
      <thead><tr><th>Dispatcher</th><th>Total</th><th>Real Call</th><th>Live Transfer</th><th>No Answer/Failed</th><th>Unique Contacts</th><th>Avg / Contact</th><th>% Real</th><th>Physical Booked</th><th>Phone Booking</th></tr></thead>
      <tbody>${rows}
        <tr style="background:#f3f4f6;font-weight:bold">
          <td>TOTAL</td><td>${totals.total}</td><td>${totals.real}</td><td>${totals.lt}</td><td>${totals.attempt}</td><td></td><td></td><td></td><td><b>${totals.phys}</b></td><td><b>${totals.phone}</b></td>
        </tr>
      </tbody>
    </table>
    <p class="small"><b>Avg / Contact</b> = total calls placed by this dispatcher / unique contacts they touched. Color: green = healthy 2-4 calls per lead, red &lt; 2 (under-pushing), yellow &gt; 4 (over-calling). <b>% Real</b> = (Real Call + Live Transfer) / Total.</p>
    <div class="summary-footer"><b>Summary:</b> ${rows.split("<tr>").length - 1} dispatchers worked ${totals.total} calls (${totals.real} real · ${totals.lt} live transfers) and originated ${totals.phys} <span class="pill-physical">Physical</span> + ${totals.phone} <span class="pill-phone">Phone Booking</span>.</div>
  </div>`;
}

// =====================================================================
// renderHourXDispatcherSection — Section 5.
// v5: first-name only columns (Frank, Mark, Angel, Ellie, Chris); drop
// "(unknown)" and "INBOUND" columns (not real dispatchers); add a "Bookings"
// column on the right and a "BOOKINGS" row at the bottom, computed from
// excelData lead rows.
// =====================================================================
function _firstNameOf(input) {
  if (!input) return "—";
  const raw = String(input).trim();
  // Try EMPLOYEES match (case-insensitive) — accept full name or first
  for (const e of EMPLOYEES) {
    const f = String(e.name || "").toLowerCase();
    const full = String(e.fullName || "").toLowerCase();
    if (raw.toLowerCase() === f || raw.toLowerCase() === full) return e.name;
    if (raw.toLowerCase().startsWith(f + " ") || raw.toLowerCase().startsWith(full + " ")) return e.name;
    if (full && raw.toLowerCase().includes(full)) return e.name;
  }
  // Fallback — just first token
  return raw.split(/\s+/)[0];
}

export function renderOldLeadsBookedSection(dispatch) {
  const all = (dispatch && dispatch.appointmentsBooked) || [];
  const old = all.filter((b) => b && b.isOldLead);
  const head = `<div class='section'><h2>Old Leads Booked Today</h2><div class='subhead'>Bookings today on leads that first came in on an earlier day - NOT included in the New-Lead booking totals above.</div>`;
  if (!old.length) return head + `<p class='small'>No older leads were booked today.</p></div>`;
  const cnt = (k) => old.filter((b) => b.kind === k).length;
  const phys = cnt('physical'), phone = cnt('phone_sale'), xfer = cnt('live_transfer');
  const byDisp = new Map();
  old.forEach((b) => byDisp.set(b.dispatcher || '-', (byDisp.get(b.dispatcher || '-') || 0) + 1));
  const label = (k) => k === 'phone_sale' ? `<span class='pill-phone'>Phone Booking</span>` : k === 'live_transfer' ? 'Live Transfer' : `<span class='pill-physical'>Physical</span>`;
  const listRows = old.map((b) => `<tr><td>${b.leadName || '(unnamed)'}</td><td>${b.dispatcher || '-'}</td><td>${b.time || ''}</td><td>${label(b.kind)}</td><td>${b.leadAgeDays == null ? '' : b.leadAgeDays + 'd'}</td></tr>`).join('');
  const dispRows = [...byDisp.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `<tr><td>${n}</td><td>${c}</td></tr>`).join('');
  return head + `<div class='summary-footer'><b>${old.length}</b> old lead${old.length === 1 ? '' : 's'} booked today &middot; ${phys} Physical &middot; ${phone} Phone${xfer ? ` &middot; ${xfer} Live Transfer` : ''}</div><table><thead><tr><th>Lead</th><th>Dispatcher</th><th>Time</th><th>Type</th><th>Age</th></tr></thead><tbody>${listRows}</tbody></table><div class='subhead' style='margin-top:8px'>By dispatcher</div><table><thead><tr><th>Dispatcher</th><th>Old Leads Booked</th></tr></thead><tbody>${dispRows}</tbody></table></div>`;
}

export function renderHourXDispatcherSection(excelData) {
  if (!excelData) return "";
  const { calls = [], newLeadRows = [], newOppRows = [], reactivatedRows = [] } = excelData;

  // Group calls by hour × first-name-dispatcher, skipping INBOUND/unknown buckets.
  const matrix = new Map();
  for (const c of calls) {
    if (c.hour == null) continue;
    const rawDisp = c.dispatcher;
    if (!rawDisp || String(rawDisp).toLowerCase() === "inbound") continue;
    if (/unknown/i.test(String(rawDisp))) continue; // drop "(unknown)" entries
    const d = _firstNameOf(rawDisp);
    if (!d || d === "—" || /unknown/i.test(d)) continue;
    if (!matrix.has(c.hour)) matrix.set(c.hour, new Map());
    const inner = matrix.get(c.hour);
    inner.set(d, (inner.get(d) || 0) + 1);
  }
  const dispSet = new Set();
  for (const inner of matrix.values()) for (const d of inner.keys()) dispSet.add(d);
  // Order dispatchers per EMPLOYEES (canonical), then any extras alphabetically.
  const canonical = EMPLOYEES.map((e) => e.name);
  const dispatchers = [
    ...canonical.filter((n) => dispSet.has(n)),
    ...[...dispSet].filter((n) => !canonical.includes(n)).sort(),
  ];

  function hourLbl(h) {
    // Display as a range — "8-9 AM" means calls placed between 8:00 and 8:59 ET.
    function single(h) {
      if (h === 0) return "12 AM";
      if (h < 12) return h + " AM";
      if (h === 12) return "12 PM";
      return (h - 12) + " PM";
    }
    const next = (h + 1) % 24;
    // Strip the period suffix from the first if they share period (e.g. "7-8 AM" not "7 AM-8 AM").
    const a = single(h);
    const b = single(next);
    const aPer = a.replace(/^\d+\s*/, "");
    const bPer = b.replace(/^\d+\s*/, "");
    const aNum = a.replace(/\s*(AM|PM)$/, "");
    const bNum = b.replace(/\s*(AM|PM)$/, "");
    if (aPer === bPer) return `${aNum}-${bNum} ${aPer}`;
    return `${a}-${b}`;
  }

  // Bookings per (hour, dispatcher) cell from excelData rows
  function _hourFromTimestamp(s) {
    if (!s) return null;
    const m = String(s).match(/(\d{2}):/);
    return m ? Number(m[1]) : null;
  }
  const bookByHourPhys = new Map();
  const bookByHourPhone = new Map();
  const bookByDispPhys = new Map();
  const bookByDispPhone = new Map();
  const cellBook = new Map(); // key `${hour}|${disp}` → {phys, phone}
  let totalPhys = 0, totalPhone = 0, totalBook = 0;
  for (const r of [...newLeadRows, ...newOppRows, ...reactivatedRows]) {
    if (!r.bookedToday) continue;
    const stage = r.finalStage || r.stage || "";
    if (stage !== "Appt. Booked" && stage !== "Over Phone Booked") continue;
    totalBook++;
    const isPhys = stage === "Appt. Booked";
    if (isPhys) totalPhys++; else totalPhone++;
    const h = _hourFromTimestamp(r.cameIn || r.activityTime);
    const disp = _firstNameOf(r.firstCaller || r.longestCallDispatcher || r.dispatcher || "");
    if (h != null) {
      const tbl = isPhys ? bookByHourPhys : bookByHourPhone;
      tbl.set(h, (tbl.get(h) || 0) + 1);
    }
    if (disp && disp !== "—") {
      const tbl = isPhys ? bookByDispPhys : bookByDispPhone;
      tbl.set(disp, (tbl.get(disp) || 0) + 1);
    }
    if (h != null && disp && disp !== "—") {
      const k = `${h}|${disp}`;
      const cur = cellBook.get(k) || { phys: 0, phone: 0 };
      if (isPhys) cur.phys++; else cur.phone++;
      cellBook.set(k, cur);
    }
  }

  const hours = [...matrix.keys()].sort((a, b) => a - b);
  const dispTotals = new Map(dispatchers.map(d => [d, 0]));
  const rows = hours.map(h => {
    const inner = matrix.get(h);
    let rowTotal = 0;
    const cells = dispatchers.map(d => {
      const n = inner.get(d) || 0;
      rowTotal += n;
      dispTotals.set(d, dispTotals.get(d) + n);
      const cellKey = `${h}|${d}`;
      const cb = cellBook.get(cellKey);
      const pills = cb ? `${cb.phys ? ` <span class="pill-physical">+${cb.phys}</span>` : ""}${cb.phone ? ` <span class="pill-phone">+${cb.phone}</span>` : ""}` : "";
      return `<td class="${n === 0 && !cb ? 'zero' : ''}">${n || ""}${pills}</td>`;
    }).join("");
    const rowPhys = bookByHourPhys.get(h) || 0;
    const rowPhone = bookByHourPhone.get(h) || 0;
    const rowBookCell = (rowPhys + rowPhone) === 0
      ? "—"
      : `${rowPhys ? `<span class="pill-physical">${rowPhys}</span>` : ""}${rowPhone ? ` <span class="pill-phone">${rowPhone}</span>` : ""}`;
    return `<tr><td>${hourLbl(h)}</td>${cells}<td><b>${rowTotal}</b></td><td>${rowBookCell}</td></tr>`;
  }).join("");

  function _dispBookingCell(d) {
    const p = bookByDispPhys.get(d) || 0;
    const q = bookByDispPhone.get(d) || 0;
    if (p + q === 0) return "0";
    return `${p ? `<span class="pill-physical">${p}</span>` : ""}${q ? ` <span class="pill-phone">${q}</span>` : ""}`;
  }
  // BOOKINGS row gets a green tint so it stands out from regular total row.
  const bookingsRow = `<tr style="background:#d1fae5;font-weight:bold"><td>BOOKINGS</td>${dispatchers.map(d => `<td>${_dispBookingCell(d)}</td>`).join("")}<td></td><td>${totalPhys ? `<span class="pill-physical"><b>${totalPhys}</b></span>` : ""} ${totalPhone ? `<span clas="pill-phone"><b>${totalPhone}</b></span>` : ""}</td></tr>`;
  const totalRow = `<tr><td><b>TOTAL</b></td>${dispatchers.map(d => `<td><b>${dispTotals.get(d) || 0}</b></td>`).join("")}<td><b>${[...dispTotals.values()].reduce((a, b) => a + b, 0)}</b></td><td><b>${totalBook}</b></td></tr>`;

  // Peak hour / top dispatcher
  let peakHour = null, peakHourCount = 0;
  for (const h of hours) {
    const inner = matrix.get(h);
    const t = [...inner.values()].reduce((a, b) => a + b, 0);
    if (t > peakHourCount) { peakHour = h; peakHourCount = t; }
  }
  let topDisp = null, topDispCount = 0;
  for (const [d, n] of dispTotals.entries()) {
    if (n > topDispCount) { topDisp = d; topDispCount = n; }
  }

  return `<div class="section">
    <h2>Section 5 — Hour × Dispatcher</h2>
    <div class="subhead">Calls per hour per dispatcher · green pills = Physical Booking · yellow pills = Phone Booking in that cell.</div>
    <table class="hxd-matrix">
      <thead><tr><th>Hour</th>${dispatchers.map(d => `<th>${esc(d)}</th>`).join("")}<th>Hour Total</th><th>Bookings</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="2" class="small">No calls today.</td></tr>'}</tbody>
      <tfoot>${bookingsRow}${totalRow}</tfoot>
    </table>
    <div class="summary-footer"><b>Summary:</b> ${peakHour != null ? `peak hour ${hourLbl(peakHour)} with ${peakHourCount} calls` : "no calls yet"} · top dispatcher ${topDisp ? esc(topDisp) + " (" + topDispCount + " calls)" : "—"} · <b>${totalBook} bookings</b> (${totalPhys} <span class="pill-physical">Physical</span> · ${totalPhone} <span class="pill-phone">Phone</span>).</div>
  </div>`;
}

// =====================================================================
// renderSection6 — Pipelines · Stages · Lead Age + Booking Funnel.
// Matches the approved mockup: pipeline overview cards, stage breakdown
// table with "Originated Bookings" column, booking-funnel narrative grouped
// by origin stage, lead-age × dispatcher matrix.
// =====================================================================
export function renderSection6(excelData) {
  if (!excelData) return "";
  const { calls = [], newLeadRows = [], newOppRows = [], reactivatedRows = [] } = excelData;

  // --- Pipeline overview cards
  const pipelineColors = {
    "Orlando Pipeline":  { bg: "#f0f9ff", border: "#0284c7", titleColor: "#075985" },
    "Tampa Pipeline":    { bg: "#f5f3ff", border: "#7c3aed", titleColor: "#5b21b6" },
    "Duct Cleaning":     { bg: "#fffbeb", border: "#d97706", titleColor: "#78350f" },
  };
  const byPipeline = new Map();
  for (const c of calls) {
    const k = c.pipelineName || "(no pipeline)";
    if (!byPipeline.has(k)) byPipeline.set(k, { total: 0, real: 0, lt: 0, na: 0, failed: 0, contacts: new Set(), bookedPhys: 0, bookedPhone: 0 });
    const d = byPipeline.get(k);
    d.total++;
    if (c.bucket === "real_call") d.real++;
    else if (c.bucket === "live_transfer") d.lt++;
    else if (c.bucket === "no_answer") d.na++;
    else if (c.bucket === "failed") d.failed++;
    if (c.raw?.contact_id) d.contacts.add(c.raw.contact_id);
  }
  // Compute the dominant pipeline FIRST (before booking attribution needs it).
  const _sortedPipelines = [...byPipeline.entries()]
    .filter(([name]) => name && name !== "(no pipeline)" && name !== "?")
    .sort((a, b) => b[1].total - a[1].total);
  const dominantPipeline = _sortedPipelines[0]?.[0] || null;
  // Attribute bookings to pipelines using each lead's CALLS — find the
  // pipeline most-used in that contact's calls today. Falls back to the
  // dominant pipeline (Orlando) when no calls are linked.
  function pipelineForRow(r) {
    if (r.pipelineName) return r.pipelineName;
    if (r.pipeline) return r.pipeline;
    // Try to find this contact's pipeline from their calls
    const cid = r._id || r.contactId || r.contact_id;
    if (cid) {
      const counts = new Map();
      for (const c of calls) {
        if (c.raw?.contact_id !== cid) continue;
        const p = c.pipelineName || null;
        if (!p) continue;
        counts.set(p, (counts.get(p) || 0) + 1);
      }
      if (counts.size > 0) {
        return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
      }
    }
    return dominantPipeline;
  }
  for (const r of [...newLeadRows, ...newOppRows, ...reactivatedRows]) {
    if (!r.bookedToday) continue;
    const k = pipelineForRow(r);
    if (!k) continue; // skip if we genuinely can't attribute
    if (!byPipeline.has(k)) byPipeline.set(k, { total: 0, real: 0, lt: 0, na: 0, failed: 0, contacts: new Set(), bookedPhys: 0, bookedPhone: 0 });
    const stage = r.finalStage || r.stage || "";
    if (stage === "Appt. Booked") byPipeline.get(k).bookedPhys++;
    if (stage === "Over Phone Booked") byPipeline.get(k).bookedPhone++;
  }
  // Show only known/significant pipelines. Drop "(no pipeline)"/"(unused)"
  // entirely unless it has serious volume (≥ 20 calls). Do NOT pad to 3 —
  // if only Orlando + Tampa have data today, render TWO cards.
  const ordered = [...byPipeline.entries()]
    .filter(([name, d]) => !/^\(no pipeline\)$|^\(unused\)$|^\?$/.test(name) || d.total >= 20)
    .filter(([name, d]) => d.total > 0 || d.bookedPhys > 0 || d.bookedPhone > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 3);
  // v6: build as <td> cells inside a table for email-client compatibility.
  const pipelineCardCells = ordered.map(([name, d]) => {
    const color = pipelineColors[name] || { bg: "#f9fafb", border: "#6b7280", titleColor: "#374151" };
    const bookings = d.bookedPhys + d.bookedPhone;
    const bookingsCell = bookings === 0
      ? `<span style="color:#9ca3af">0</span>`
      : `${bookings} <span class="pill-physical">${d.bookedPhys} Physical</span> <span class="pill-phone">${d.bookedPhone} Phone</span>`;
    const cellWidth = `${Math.floor(100 / Math.max(1, ordered.length))}%`;
    return `<td style="vertical-align:top;padding:0;border:none;width:${cellWidth}">
      <div class="pipeline-card" style="background:${color.bg};border-top:4px solid ${color.border}">
        <div class="pc-title" style="color:${color.titleColor}">${esc(name)}</div>
        <div class="pc-big">${d.total}</div>
        <table>
          <tr><td>Real Calls</td><td>${d.real}</td></tr>
          <tr><td>Live Transfers</td><td>${d.lt}</td></tr>
          <tr><td>Unique Contacts</td><td>${d.contacts.size}</td></tr>
          <tr><td><b>Bookings Today</b></td><td style="color:${bookings > 0 ? "#065f46" : "#9ca3af"}">${bookingsCell}</td></tr>
        </table>
      </div>
    </td>`;
  }).join("");
  const pipelineCardsHtml = `<table style="width:100%;border-collapse:separate;border-spacing:12px 0;margin:8px 0;border:none"><tr>${pipelineCardCells}</tr></table>`;

  // --- Stage breakdown
  const byStage = new Map();
  for (const c of calls) {
    const k = (c.pipelineName || "?") + " → " + (c.stageName || "?");
    if (!byStage.has(k)) byStage.set(k, { total: 0, real: 0, lt: 0, na: 0, failed: 0, contacts: new Set(), bookedPhys: 0, bookedPhone: 0 });
    const d = byStage.get(k);
    d.total++;
    if (c.bucket === "real_call") d.real++;
    else if (c.bucket === "live_transfer") d.lt++;
    else if (c.bucket === "no_answer") d.na++;
    else if (c.bucket === "failed") d.failed++;
    if (c.raw?.contact_id) d.contacts.add(c.raw.contact_id);
  }
  // Originated Bookings: bookings whose stage at start of day was this stage.
  // For new leads / resubs, origin stage is "New Lead In". Use the same
  // pipelineForRow fallback so we don't end up with "? → New Lead In" rows.
  for (const r of newLeadRows) {
    if (!r.bookedToday) continue;
    const pname = pipelineForRow(r);
    if (!pname) continue;
    const k = pname + " → New Lead In";
    if (!byStage.has(k)) byStage.set(k, { total: 0, real: 0, lt: 0, na: 0, failed: 0, contacts: new Set(), bookedPhys: 0, bookedPhone: 0 });
    const stage = r.finalStage || "";
    if (stage === "Appt. Booked") byStage.get(k).bookedPhys++;
    if (stage === "Over Phone Booked") byStage.get(k).bookedPhone++;
  }
  for (const r of newOppRows) {
    if (!r.bookedToday) continue;
    const pname = pipelineForRow(r);
    if (!pname) continue;
    const k = pname + " → New Lead In";
    if (!byStage.has(k)) byStage.set(k, { total: 0, real: 0, lt: 0, na: 0, failed: 0, contacts: new Set(), bookedPhys: 0, bookedPhone: 0 });
    const stage = r.finalStage || "";
    if (stage === "Appt. Booked") byStage.get(k).bookedPhys++;
    if (stage === "Over Phone Booked") byStage.get(k).bookedPhone++;
  }
  const stageRows = [...byStage.entries()]
    .sort((a, b) => b[1].total - a[1].total)
    .map(([k, d]) => {
      const totalBookings = d.bookedPhys + d.bookedPhone;
      const bookingsCell = totalBookings > 0
        ? `<b>${totalBookings}</b> ${d.bookedPhys ? `<span class="pill-physical">${d.bookedPhys} Physical</span>` : ""} ${d.bookedPhone ? `<span class="pill-phone">${d.bookedPhone} Phone</span>` : ""}`
        : "0";
      const rowStyle = totalBookings > 0 ? ' style="background:#ecfdf5"' : "";
      const parts = k.split(" → ");
      return `<tr${rowStyle}><td><b>${esc(parts[0])}</b> → ${esc(parts.slice(1).join(" → "))}</td><td>${d.total}</td><td>${d.real}</td><td>${d.lt}</td><td>${d.na}</td><td>${d.failed}</td><td>${d.contacts.size}</td><td>${bookingsCell}</td></tr>`;
    })
    .join("");

  // --- Booking Funnel narrative
  const newBookings = newLeadRows.filter((r) => r.bookedToday);
  const resubBookings = newOppRows.filter((r) => r.bookedToday);
  const reactBookings = reactivatedRows.filter((r) => r.bookedToday);

  function bookingLine(row, cat) {
    const stage = row.finalStage || row.stage || "";
    const bookingTypePill = stage === "Appt. Booked"
      ? '<span class="pill-physical">Physical Booking</span>'
      : stage === "Over Phone Booked"
      ? '<span class="pill-phone">Phone Booking</span>'
      : "—";
    const name = row.leadName || row.name || "(unknown)";
    const source = row.leadSource || row.source || "";
    const dur = row.longestCallDuration || row.durationFmt || "";
    const resp = row.responseTime || "";
    const ageSuffix = cat === "RESUB"
      ? ` · <span style="background:#fde68a;color:#78350f;padding:1px 5px;border-radius:6px;font-weight:600">RESUBMISSION today</span>`
      : cat === "REACT"
      ? ` · ${row.ageDays ? row.ageDays + "d old" : ""}`
      : "";
    // v17: borrow Section 3's exact logic — Section 3 already renders correct
    // CALL/SMS/LT badges in its Booking Method column for every booked row.
    // Re-implement the same pattern verbatim for Section 6 funnel.
    const cid = row._id || row.contactId || row.contact_id || row.id;
    let methodInline = "Unknown";
    if (row.bookedToday) {
      const _myCalls = (excelData.calls || []).filter((c) => (c.raw && c.raw.contact_id) === cid);
      if (_myCalls.some((c) => c.bucket === "live_transfer")) methodInline = "Live Transfer";
      else if (_myCalls.some((c) => c.bucket === "real_call" || (Number(c.durationSec || 0) >= 70))) methodInline = "Call";
      else methodInline = "SMS"; // booked but no qualifying call → SMS
    }
    let methodPill = "";
    if (methodInline === "Live Transfer") methodPill = ' <span class="badge badge-warn">via Live Transfer</span>';
    else if (methodInline === "Call") methodPill = ' <span class="badge badge-good">via Call</span>';
    else if (methodInline === "SMS") methodPill = ' <span class="badge badge-bad" style="background:#fee2e2;color:#991b1b">via SMS</span>';
    // Dispatcher: prefer bookingSources (has SMS sender from Conversations API), else row's caller fields.
    const bSrc = (excelData.bookingSources && excelData.bookingSources.get) ? excelData.bookingSources.get(cid) : null;
    const disp = bSrc?.dispatcher || row.firstCaller || row.dispatcher || row.longestCallDispatcher || "";
    // Hide response time entirely if it's negative (resub bug — measured from
    // original lead date instead of resubmission timestamp).
    const respOk = resp && cat !== "REACT" && !/^-/.test(String(resp)) && resp !== "Never";
    const showDur = methodInline === "SMS" ? "" : (dur ? "· " + esc(dur) + " real call" : "");
    return `<div style="font-size:13px;padding:4px 0;border-top:1px dashed #e5e7eb">→ <b>${esc(name)}</b> <span class="small">(${esc(source)} · ${cat}${ageSuffix})</span> &nbsp;${bookingTypePill}${methodPill}<br>
      <span class="small" style="margin-left:18px">${stage ? esc(stage) : "—"} &nbsp;·&nbsp; ${esc(disp)} ${showDur} ${respOk ? "· response " + esc(resp) : ""}</span>
    </div>`;
  }
  const newLeadFunnel = newBookings.map((r) => bookingLine(r, "NEW")).join("");
  const resubFunnel = resubBookings.map((r) => bookingLine(r, "RESUB")).join("");
  const reactFunnel = reactBookings.map((r) => bookingLine(r, "REACT")).join("");

  const totalBookings = newBookings.length + resubBookings.length + reactBookings.length;
  const fromNewLeadIn = newBookings.length + resubBookings.length;

  const funnelHtml = `<div class="funnel-box">
    <div style="font-size:14px;font-weight:700;color:#1f2937;margin-bottom:8px">${totalBookings} booking${totalBookings === 1 ? "" : "s"} today</div>

    <div class="funnel-row">
      <div class="funnel-badge ${fromNewLeadIn > 0 ? "active" : "inactive"}">From <b>New Lead In</b><br><span style="font-size:18px">${fromNewLeadIn}</span><br><span class="small" style="font-weight:400">${newBookings.length} fresh${resubBookings.length > 0 ? " + " + resubBookings.length + " resub" : ""}</span></div>
      <div style="flex:1">
        ${fromNewLeadIn === 0 ? '<div class="small" style="margin-top:4px;color:#9ca3af">No bookings from New Lead In today.</div>' : ""}
        ${newLeadFunnel}
        ${resubFunnel}
      </div>
    </div>

    <div class="funnel-row" ${reactBookings.length === 0 ? 'style="color:#9ca3af"' : ""}>
      <div class="funnel-badge ${reactBookings.length > 0 ? "active" : "inactive"}">From <b>Reactivation</b><br><span style="font-size:18px">${reactBookings.length}</span></div>
      <div style="flex:1">
        ${reactBookings.length === 0
          ? `<div class="small" style="margin-top:4px">No old leads booked today. ${reactivatedRows.length} reactivation${reactivatedRows.lengt === 1 ? "" : "s"} had real calls but didn't convert.</div>`
          : reactFunnel}
      </div>
    </div>
  </div>`;

  // --- Lead Age × Dispatcher matrix
  // ageBucket values: "Today", "2-3 days", "4-7 days", "8+ days", "Unknown"
  const ORDER = ["Today", "2-3 days", "4-7 days", "8+ days"];
  const dispSet2 = new Set(calls.map((c) => c.dispatcher).filter((d) => d && d !== "INBOUND"));
  const ladDispatchers = [...dispSet2].sort();
  const lad = new Map(ORDER.map((k) => [k, { byD: new Map(), real: 0, bookedPhys: 0, bookedPhone: 0, uniqueContacts: new Set() }]));
  for (const c of calls) {
    const k = ORDER.includes(c.ageBucket) ? c.ageBucket : null;
    if (!k) continue;
    const bucket = lad.get(k);
    const d = c.dispatcher || "—";
    bucket.byD.set(d, (bucket.byD.get(d) || 0) + 1);
    if (c.bucket === "real_call" || c.bucket === "live_transfer") bucket.real++;
    if (c.raw?.contact_id) bucket.uniqueContacts.add(c.raw.contact_id);
  }
  // attribute bookings to lead-age (using the lead's age if available)
  // approximation: NEW = Today, RESUB = Today (newly reset), REACT = from ageDays
  function ageBucketFromDays(days) {
    if (days == null) return null;
    if (days <= 1) return "Today";
    if (days <= 3) return "2-3 days";
    if (days <= 7) return "4-7 days";
    return "8+ days";
  }
  for (const r of newLeadRows) {
    if (!r.bookedToday) continue;
    const stage = r.finalStage || "";
    const b = lad.get("Today");
    if (b) {
      if (stage === "Appt. Booked") b.bookedPhys++;
      if (stage === "Over Phone Booked") b.bookedPhone++;
    }
  }
  for (const r of newOppRows) {
    if (!r.bookedToday) continue;
    const stage = r.finalStage || "";
    const b = lad.get("Today");
    if (b) {
      if (stage === "Appt. Booked") b.bookedPhys++;
      if (stage === "Over Phone Booked") b.bookedPhone++;
    }
  }
  for (const r of reactBookings) {
    const bucket = ageBucketFromDays(r.ageDays);
    if (!bucket || !lad.has(bucket)) continue;
    const stage = r.stage || "";
    const b = lad.get(bucket);
    if (stage === "Appt. Booked") b.bookedPhys++;
    if (stage === "Over Phone Booked") b.bookedPhone++;
  }
  let ladTotalCalls = 0;
  let ladTotalReal = 0;
  const ladTotalsByD = new Map(ladDispatchers.map((d) => [d, 0]));
  const ladRows = ORDER.map((k) => {
    const b = lad.get(k);
    let rowTotal = 0;
    const cells = ladDispatchers.map((d) => {
      const n = b.byD.get(d) || 0;
      rowTotal += n;
      ladTotalsByD.set(d, ladTotalsByD.get(d) + n);
      let bg = "";
      if (n > 50) bg = "background:#1e40af;color:white";
      else if (n > 20) bg = "background:#bfdbfe";
      else if (n > 5) bg = "background:#dbeafe";
      else if (n > 0) bg = "background:#eff6ff";
      return `<td style="${bg}">${n || ""}</td>`;
    }).join("");
    ladTotalCalls += rowTotal;
    ladTotalReal += b.real;
    const bookingsCell = (b.bookedPhys + b.bookedPhone) > 0
      ? `${b.bookedPhys ? `<span class="pill-physical">${b.bookedPhys}</span> ` : ""}${b.bookedPhone ? `<span class="pill-phone">${b.bookedPhone}</span>` : ""}`
      : "—";
    return `<tr><td><b>${k}</b><br><span class="small">${b.uniqueContacts.size} unique contacts</span></td>${cells}<td><b>${rowTotal}</b></td><td>${b.real}</td><td>${bookingsCell}</td></tr>`;
  }).join("");
  const ladTotalRow = `<tr style="background:#f3f4f6;font-weight:bold"><td>TOTAL</td>${ladDispatchers.map((d) => `<td>${ladTotalsByD.get(d) || 0}</td>`).join("")}<td>${ladTotalCalls}</td><td>${ladTotalReal}</td><td>${totalBookings}</td></tr>`;

  // Summary footer
  const summary = totalBookings === 0
    ? `<b>Summary:</b> ${calls.length} calls placed across ${byPipeline.size} pipeline${byPipeline.size === 1 ? "" : "s"} — no bookings originated today.`
    : `<b>Summary:</b> ${totalBookings} originated booking${totalBookings === 1 ? "" : "s"} today (${newBookings.length} from fresh New Lead In · ${resubBookings.length} from resubmissions · ${reactBookings.length} from reactivations) across ${byPipeline.size} pipeline${byPipeline.size === 1 ? "" : "s"}.`;

  return `<div class="section">
    <h2>Section 6 — Pipelines · Stages · Lead Age</h2>
    <div class="subhead">Where the calls land — by pipeline, by stage, and by how old the lead is. With dispatcher attribution.</div>

    ${pipelineCardsHtml}

    <h3 style="margin-top:24px">Stage breakdown — calls per pipeline-stage today</h3>
    <table>
      <thead><tr><th>Pipeline → Stage</th><th>Total</th><th>Real</th><th>LT</th><th>NA</th><th>Failed</th><th>Unique</th><th>Originated Bookings</th></tr></thead>
      <tbody>${stageRows || '<tr><td colspan="8" class="small">No stage data today.</td></tr>'}</tbody>
    </table>
    <p class="small"><b>Originated Bookings</b> = bookings made today whose stage at start of day was this one. Tells you which stages are <i>producing</i> bookings, not which stage they end up in.</p>

    <h3 style="margin-top:24px">Booking Funnel — where today's bookings came from</h3>
    ${funnelHtml}
    <p class="small" style="margin-top:8px;background:#f0f9ff;padding:8px 12px;border-left:3px solid #0284c7;border-radius:4px;color:#0c4a6e">
      <b>Workflow:</b> When a dispatcher gets a lead on the phone, the preferred path is a <b>live transfer</b> to Sal (sales). If Sal isn't available, the dispatcher books the lead into <b>Over Phone Booked</b> — a phone-callback slot. Sal then calls the lead back and either closes a phone sale or upgrades them to a <b>Physical Booking</b> (Appt. Booked).
    </p>

    <h3 style="margin-top:24px">Lead Age × Dispatcher — who's working which age bucket</h3>
    <p class="small" style="margin:0 0 6px">Healthy pattern: fresh leads (Today / 2-3d) handled by experienced dispatchers; older buckets reasonable to assign to trainees. Cells shaded by relative volume.</p>
    <table>
      <thead><tr><th>Lead Age</th>${ladDispatchers.map((d) => `<th>${esc(d)}</th>`).join("")}<th>Total</th><th>Real Calls</th><th>Bookings</th></tr></thead>
      <tbody>${ladRows}${ladTotalRow}</tbody>
    </table>

    <div class="summary-footer">${summary}</div>
  </div>`;
}

// Back-compat alias — old callers
export const renderPipelineAndFunnelSection = renderSection6;

// =====================================================================
// renderEmail — outer shell (banner + sections + footer).
// =====================================================================
export function renderEmail({ title, generatedAt, sections }) {
  const dt = generatedAt ? DateTime.fromISO(generatedAt).setZone(TZ) : DateTime.now().setZone(TZ);
  const dateStr = dt.toFormat("ccc, LLLL d, yyyy");
  const timeStr = dt.toFormat("h:mm a 'EDT'");
  const subjectLine = title || "Full Day Summary";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Local AC — ${esc(subjectLine)} (${esc(dateStr)})</title>
${STYLES}
</head>
<body>
<div class="container">
  <div class="banner">
    <div class="eyebrow">❄ Local AC · Control Room</div>
    <h1>${esc(subjectLine)}</h1>
    <div class="meta">${esc(dateStr)} · generated ${esc(timeStr)}</div>
  </div>
  ${(sections || []).join("\n")}
  <div class="footer">
    Local AC Reports Bot · <a href="https://local-ac-reports-bot.onrender.com">control room</a>
  </div>
</div>
</body>
</html>`;
}

// =====================================================================
// renderLiveAlert — kept as-is.
// =====================================================================
export function renderLiveAlert({ leadName, phone, leadAddedAt, minutesElapsed, level }) {
  const color = level === "critical" ? "#991b1b" : level === "warning" ? "#92400e" : "#1e3a8a";
  const bg = level === "critical" ? "#fee2e2" : level === "warning" ? "#fef3c7" : "#dbeafe";
  const headline = level === "critical" ? "🚨 10-min no-callback" : level === "warning" ? "⚠ 3-min no-callback" : "Info";
  const when = leadAddedAt ? DateTime.fromISO(leadAddedAt).setZone(TZ).toFormat("h:mm a") : "—";
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${STYLES}</head>
<body>
<div class="container">
  <div class="banner" style="background:linear-gradient(135deg,${color} 0%,${color} 100%)">
    <div class="eyebrow">❄ Local AC · Live Alert</div>
    <h1>${headline}</h1>
    <div class="meta">${esc(leadName || "")} · came in ${esc(when)} · ${esc(String(minutesElapsed))} min elapsed</div>
  </div>
  <div class="section" style="border-left:4px solid ${color};background:${bg}">
    <h2 style="color:${color}">${esc(leadName || "Unknown lead")}</h2>
    <div class="subhead" style="color:${color}">
      Phone: ${esc(phone || "—")} · Lead added at ${esc(when)} · ${esc(String(minutesElapsed))} minutes ago and no callback yet.
    </div>
  </div>
  <div class="footer">Local AC Reports Bot — live new-lead alert</div>
</div>
</body></html>`;
}

// Back-compat: the old renderDispatcherSection exported both sections in one
// blob and had a Slow Response panel. We split it into renderCallActivitySection
// and renderDispatcherPerformanceSection so order is 1→2→3→4→5→6.
// Keep a shim for any caller that still imports the old name.
export function renderDispatcherSection(dispatch) {
  return renderCallActivitySection(dispatch) + renderDispatcherPerformanceSection(dispatch);
}
