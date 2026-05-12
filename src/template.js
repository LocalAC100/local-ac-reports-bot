// template.js — May 7 "NEW REPORT FORMAT MOCKUP v2" aligned design.
// Exports (signatures unchanged): renderEmail, renderHubstaffSection,
// renderDispatcherSection, renderLiveAlert.
//
// The look-and-feel here mirrors src/email-mockup.html (the approved design):
// gradient blue banner with snowflake eyebrow, white card sections with
// 1px border + rounded corners, blue h2 section titles, badge/pill styles
// matching the mockup palette.

import { DateTime } from "luxon";
import { EMPLOYEES } from "./employees.js";
import { TZ, fmtTime, fmtDuration } from "./time.js";

// =====================================================================
// Shared CSS (cherry-picked from email-mockup.html so the email is
// self-contained and email clients render it consistently).
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
  .placeholder-section { background: #fffbeb; border: 1px dashed #fbbf24; color: #78350f; }
</style>`;

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

const fmtClock = (iso) => {
  if (!iso) return "—";
  try {
    return DateTime.fromISO(iso).setZone(TZ).toFormat("h:mm a");
  } catch {
    return "—";
  }
};

const fmtMinutes = (mins) => {
  if (mins == null || isNaN(mins)) return "—";
  const h = Math.floor(mins / 60);
  const m = Math.floor(mins % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
};

const employeeScheduleText = (name, weekday) => {
  const emp = EMPLOYEES.find((e) => e.name === name);
  if (!emp) return "—";
  const shift = emp.schedule?.[weekday];
  if (!shift) return "off";
  // shift = { start: "08:00", end: "21:00", breakMinutes: 60 } (assumed shape)
  const s = shift.start || shift[0];
  const e = shift.end || shift[1];
  if (!s || !e) return "—";
  return `${fmtTimeShort(s)} – ${fmtTimeShort(e)}`;
};

const fmtTimeShort = (hhmm) => {
  if (!hhmm) return "";
  const [h, m] = String(hhmm).split(":").map(Number);
  if (isNaN(h)) return hhmm;
  const period = h >= 12 ? "PM" : "AM";
  const hr = ((h + 11) % 12) + 1;
  return `${hr}:${String(m || 0).padStart(2, "0")} ${period}`;
};

// =====================================================================
// renderHubstaffSection — Section 1 of the mockup.
// =====================================================================
export function renderHubstaffSection(hub) {
  const rows = (hub?.perEmployee || []).map((emp) => {
    const statusClass =
      emp.statusFlag === "ok" || emp.statusFlag === "on_track"
        ? "badge-good"
        : emp.statusFlag === "no_data"
        ? "badge-warn"
        : "badge-bad";
    const statusText =
      emp.statusFlag === "ok" || emp.statusFlag === "on_track"
        ? "✓ on track"
        : emp.statusFlag === "no_data"
        ? "no Hubstaff yet"
        : emp.statusFlag === "early_out"
        ? "❌ Early Out"
        : emp.statusFlag === "late_in"
        ? "❌ Late In"
        : emp.statusFlag === "hours_short"
        ? "❌ Hours short"
        : emp.statusFlag === "break_over"
        ? "❌ Break over"
        : esc(emp.statusFlag || "—");

    return `<tr>
        <td><b>${esc(emp.name)}</b><br><span class="small">${esc(emp.role || "")}</span></td>
        <td>${esc(emp.scheduleText || "")}<br><span class="small">${esc(emp.scheduleSummary || "")}</span></td>
        <td>${emp.clockIn ? fmtClock(emp.clockIn) : "—"}</td>
        <td>${emp.clockOut ? fmtClock(emp.clockOut) : "—"}</td>
        <td><b>${fmtMinutes(emp.workedMinutes)}</b></td>
        <td>${fmtMinutes(emp.breakMinutes)}</td>
        <td>${emp.activityPct != null ? `${emp.activityPct}%` : "—"}</td>
        <td><span class="badge ${statusClass}">${statusText}</span></td>
      </tr>`;
  }).join("");

  const flags = (hub?.manipulationFlags || []).concat(hub?.discrepancies || []).concat(hub?.lowActivityFlags || []);
  const flagsHtml = flags.length
    ? `<h3>Red flags</h3>
<ul style="margin:0;padding-left:18px;font-size:13px;line-height:1.6">
${flags.map((f) => {
  const text = typeof f === "string" ? f : (f.text || JSON.stringify(f));
  const color = (f && f.color) || "#C0392B";
  return `<li style="margin-bottom:6px;color:${esc(color)}">🔴 ${esc(text)}</li>`;
}).join("\n")}
</ul>`
    : "";

  // Day total table
  const totals = hub?.totalsByEmployee || [];
  const totalCost = totals.reduce((s, r) => s + (Number(r.cost) || 0), 0);
  const totalMinutes = totals.reduce((s, r) => s + (Number(r.minutes) || 0), 0);
  const dayTotalRows = totals.map((r) => `<tr>
      <td>${esc(r.name)}</td>
      <td>${fmtMinutes(r.minutes)}</td>
      <td>${esc(r.payRate || "")}</td>
      <td>$${(Number(r.cost) || 0).toFixed(2)}</td>
    </tr>`).join("");

  const dayTotalHtml = totals.length
    ? `<h3>Day Total — paid hours</h3>
<table>
  <thead><tr><th>Employee</th><th>Worked (paid)</th><th>Pay Rate</th><th>Cost</th></tr></thead>
  <tbody>
    ${dayTotalRows}
    <tr style="background:#f3f4f6;font-weight:bold"><td>TOTAL</td><td>${fmtMinutes(totalMinutes)}</td><td></td><td>$${totalCost.toFixed(2)}</td></tr>
  </tbody>
</table>`
    : "";

  const flagsCount = flags.length;
  const headerBadge = flagsCount > 0
    ? `<span class="badge badge-warn" style="margin-left:8px;font-size:12px;letter-spacing:.2px">⚠ ${flagsCount} item${flagsCount === 1 ? "" : "s"} need attention</span>`
    : "";

  return `<div class="section">
  <h2>Section 1 — Hubstaff (Hours &amp; Activity) ${headerBadge}</h2>
  <div class="subhead">Per-employee clock-in/out, worked-within-shift, activity %, and red-flag screening.</div>
  <table>
    <thead><tr><th>Employee</th><th>Schedule</th><th>Clock In</th><th>Clock Out</th><th>Worked</th><th>Break</th><th>Activity</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  ${flagsHtml}
  ${dayTotalHtml}
</div>`;
}

// =====================================================================
// renderDispatcherSection — Section 4 of the mockup.
// =====================================================================
export function renderDispatcherSection(dispatch) {
  const byD = dispatch?.byDispatcher || [];

  // Section 2 — Call Activity (Day Totals) — pulled from dispatch rollup.
  const sum = byD.reduce((acc, d) => {
    acc.total += (d.real || 0) + (d.voicemail || 0) + (d.attempt || 0) + (d.liveTransfers || 0);
    acc.real += d.real || 0;
    acc.lt += d.liveTransfers || 0;
    acc.vm += d.voicemail || 0;
    acc.attempt += d.attempt || 0;
    return acc;
  }, { total: 0, real: 0, lt: 0, vm: 0, attempt: 0 });

  const dayTotalsSection = `<div class="section" style="padding:14px 24px">
  <h2 style="font-size:16px">Section 2 — Call Activity (Day Totals)</h2>
  <div style="display:flex;flex-wrap:wrap;gap:0;align-items:baseline;font-size:13px;margin-top:6px;color:#1f2937;line-height:1.7">
    <span><span style="color:#6b7280">Total:</span> <b style="font-size:16px;color:#1f4e78">${sum.total}</b></span>
    <span style="color:#d1d5db;margin:0 12px">|</span>
    <span><span style="color:#6b7280">Real:</span> <b style="color:#1f4e78">${sum.real}</b></span>
    <span style="color:#d1d5db;margin:0 12px">|</span>
    <span><span style="color:#6b7280">Live Transfers:</span> <b style="color:#1f4e78">${sum.lt}</b></span>
    <span style="color:#d1d5db;margin:0 12px">|</span>
    <span><span style="color:#6b7280">Voicemails:</span> <b style="color:#1f4e78">${sum.vm}</b></span>
    <span style="color:#d1d5db;margin:0 12px">|</span>
    <span><span style="color:#6b7280">No Answer / Failed:</span> <b style="color:#1f4e78">${sum.attempt}</b></span>
    <span style="color:#d1d5db;margin:0 12px">|</span>
    <span class="small">REAL_CALL_THRESHOLD = 70s</span>
  </div>
</div>`;

  // Section 4 — Dispatcher Performance — per-dispatcher rollup.
  const rows = byD.map((d) => {
    const ratio = d.bookingRatio != null
      ? `<span class="badge ${d.bookingRatio >= 2 && d.bookingRatio <= 4 ? "badge-good" : d.bookingRatio < 2 ? "badge-bad" : "badge-warn"}">${(d.bookingRatio).toFixed(2)}</span>`
      : "—";
    const totalCalls = (d.real || 0) + (d.voicemail || 0) + (d.attempt || 0) + (d.liveTransfers || 0);
    const pctReal = totalCalls > 0 ? `${(((d.real || 0) + (d.liveTransfers || 0)) / totalCalls * 100).toFixed(1)}%` : "—";
    return `<tr>
      <td><b>${esc(d.name)}</b><br><span class="small">${esc(d.role || "")}</span></td>
      <td>${totalCalls}</td>
      <td>${d.real || 0}</td>
      <td>${d.liveTransfers || 0}</td>
      <td>${d.voicemail || 0}</td>
      <td>${d.attempt || 0}</td>
      <td>${ratio}</td>
      <td>${pctReal}</td>
      <td>${d.physBookings ? `<b>${d.physBookings}</b> <span class="pill-physical">Physical</span>` : "0"}</td>
      <td>${d.phBookings ? `<b>${d.phBookings}</b> <span class="pill-phone">Phone Booking</span>` : "0"}</td>
    </tr>`;
  }).join("");

  const dispatcherSection = `<div class="section">
  <h2>Section 4 — Dispatcher Performance</h2>
  <div class="subhead">Per-dispatcher rollup with bookings broken out.</div>
  <table>
    <thead><tr><th>Dispatcher</th><th>Total</th><th>Real Call</th><th>Live Transfer</th><th>Voicemail</th><th>No Answer/Failed</th><th>Avg / Contact</th><th>% Real</th><th>Physical Booked</th><th>Phone Booking</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="small">
    <b>Avg / Contact</b> color: green = healthy 2-4 calls per lead, red &lt; 2 (under-pushing), yellow &gt; 4 (over-calling).
    <b>% Real</b> = (Real Call + Live Transfer) / Total.
  </p>
</div>`;

  // Response time alerts (if any) — fold into a small subsection
  const responseAlerts = (dispatch?.responseTimeAlerts || []).filter((a) => a.late);
  const alertsHtml = responseAlerts.length
    ? `<div class="section" style="border-left:4px solid #ef4444">
    <h2 style="font-size:16px;color:#991b1b">⚠ Slow Response — leads &gt; 3 min</h2>
    <ul style="margin:6px 0;padding-left:18px;font-size:13px;line-height:1.6">
      ${responseAlerts.map((a) => `<li><b>${esc(a.leadName)}</b> — first dispatcher ${esc(a.dispatcher)} — delay ${esc(String(a.delayMinutes))} min</li>`).join("")}
    </ul>
  </div>`
    : "";

  // Placeholder for Sections 3, 5, 6 — data not yet computed in section builders.
  const placeholder = `<div class="section placeholder-section">
  <h2 style="color:#78350f">Sections 3, 5, 6 — coming next pass</h2>
  <div class="subhead" style="color:#78350f">
    Lead Activity (NEW / RESUB / REACT 3-column), Hour × Dispatcher matrix, and Pipelines · Stages · Lead Age + Booking Funnel are in the Excel attachment today; they'll land in this email body in the next iteration.
  </div>
</div>`;

  return dayTotalsSection + alertsHtml + dispatcherSection + placeholder;
}

// =====================================================================
// renderEmail — outer shell (banner + sections + footer).
// =====================================================================
export function renderEmail({ title, generatedAt, sections }) {
  const dt = generatedAt
    ? DateTime.fromISO(generatedAt).setZone(TZ)
    : DateTime.now().setZone(TZ);
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
// renderLiveAlert — kept simple. Style aligned with mockup palette.
// =====================================================================
export function renderLiveAlert({ leadName, phone, leadAddedAt, minutesElapsed, level }) {
  const color = level === "critical" ? "#991b1b" : level === "warning" ? "#92400e" : "#1e3a8a";
  const bg = level === "critical" ? "#fee2e2" : level === "warning" ? "#fef3c7" : "#dbeafe";
  const headline = level === "critical" ? "🚨 10-min no-callback" : level === "warning" ? "⚠ 3-min no-callback" : "Info";
  const when = leadAddedAt
    ? DateTime.fromISO(leadAddedAt).setZone(TZ).toFormat("h:mm a")
    : "—";

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
