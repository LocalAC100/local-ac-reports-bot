// Multi-day aggregation for the /dispatch page (weekly / monthly / custom-range).
//
// Reuses buildHubstaffSection + buildDispatcherSection from reports.js — both
// accept arbitrary {from, to} DateTime ranges and aggregate internally. That
// lets us assemble a range view with TWO upstream API calls instead of N×2.
//
// Per Alex's spec (May 14 2026):
//   - Counts → sum
//   - Per-employee hours → sum across days
//   - Response time / durations → average (recomputed from raw)
//   - Activity % → recompute from raw (totalActive / totalTracked)
//   - Hubstaff status badge → replaced with "X / N days late"
//   - Hour × Dispatcher matrix → totals with "(N days)" label
//   - Lead activity / booking funnel detail tables → hidden (per-day only)
//   - Summary stats with averages where it makes sense (e.g. avg response time)

import { DateTime } from "luxon";
import { TZ } from "./time.js";
import { EMPLOYEES, expectedShiftFor } from "./employees.js";
import {
  buildHubstaffSection,
  buildDispatcherSection,
} from "./reports.js";

function _hhmmToMin(s) {
  if (!s || typeof s !== "string") return null;
  const [h, m] = s.split(":").map((x) => parseInt(x, 10));
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Sum scheduled paid minutes for an employee across the date range, day by day.
// Matches the daily report's pay formula: shift length minus break budget.
// Days the employee is off (schedule[dow] = null) contribute 0.
function scheduledPaidMinutes(emp, from, to) {
  if (!emp?.schedule) return 0;
  const brkBudget = emp.breakMinutesPerShift ?? 0;
  let total = 0;
  let cur = from.setZone(TZ).startOf("day");
  const end = to.setZone(TZ).startOf("day");
  for (let i = 0; i < 62 && cur <= end; i++) {
    const shift = expectedShiftFor(emp, cur);
    if (shift) {
      const startMin = _hhmmToMin(shift.start);
      const endMin = _hhmmToMin(shift.end);
      if (startMin != null && endMin != null) {
        total += Math.max(0, endMin - startMin - brkBudget);
      }
    }
    cur = cur.plus({ days: 1 });
  }
  return total;
}

function fmtMinutes(min) {
  if (min == null || !isFinite(min)) return "—";
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  if (r === 0) return `${h}h`;
  return `${h}h ${r}m`;
}

function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function daysInRange(from, to) {
  // Inclusive count of calendar days (ET) in the range.
  const a = from.setZone(TZ).startOf("day");
  const b = to.setZone(TZ).startOf("day");
  return Math.max(1, Math.round(b.diff(a, "days").days) + 1);
}

// ---------- HTML helpers ----------
function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderRangeHeader({ mode, from, to, generatedAt }) {
  const fmt = (d) => d.setZone(TZ).toFormat("LLL d, yyyy");
  const dayCount = daysInRange(from, to);
  const label =
    mode === "weekly"
      ? `Weekly view — ${fmt(from)} → ${fmt(to)} (${dayCount} days)`
      : mode === "monthly"
      ? `Monthly view — ${from.setZone(TZ).toFormat("LLLL yyyy")} (${dayCount} days)`
      : `Custom range — ${fmt(from)} → ${fmt(to)} (${dayCount} days)`;
  return `<div style="padding:16px 20px;background:#f5f7fb;border:1px solid #e0e6ee;border-radius:8px;margin-bottom:18px">
    <div style="font-size:13px;color:#5a6376;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">${escape(mode)}</div>
    <div style="font-size:20px;font-weight:700;color:#1b2435;margin-top:4px">${escape(label)}</div>
    <div style="font-size:12px;color:#7a8294;margin-top:6px">Generated ${escape(generatedAt.setZone(TZ).toFormat("LLL d, h:mm a"))} ET</div>
  </div>`;
}

// ---------- Section 1 — Hubstaff (aggregated) ----------
// perEmployee rows from buildHubstaffSection have shape:
//   { name, role, clockIn, clockOut, workedMinutes, breakMinutes, breakOver,
//     activityPct, activityFlag, statusFlag }
// Pay formula matches the daily report:
//   scheduled_min_per_day = shift_length - break_budget   (days off contribute 0)
//   range_scheduled_min   = sum of per-day scheduled across the date range
//   paid_min              = min(worked, range_scheduled)
//   cost                  = (paid_min / 60) * pay_rate
function renderHubstaffAggregated(hub, { from, to }) {
  const dayCount = daysInRange(from, to);
  const rowsData = (hub.perEmployee || []).map((emp) => {
    const rosterEmp = EMPLOYEES.find(
      (e) =>
        String(e.name || "").toLowerCase() === String(emp.name || "").toLowerCase() ||
        String(e.fullName || "").toLowerCase() === String(emp.name || "").toLowerCase()
    );
    const workedMin = emp.noHubstaff ? null : emp.workedMinutes || 0;
    const scheduledMin = rosterEmp ? scheduledPaidMinutes(rosterEmp, from, to) : 0;
    const paidMin =
      workedMin == null
        ? null
        : scheduledMin > 0
        ? Math.min(workedMin, scheduledMin)
        : workedMin;
    const payRate = rosterEmp?.payRate ?? 0;
    const cost = paidMin != null ? (paidMin / 60) * payRate : 0;
    const activityPct = emp.activityPct ?? 0;
    return {
      name: emp.name,
      noHubstaff: emp.noHubstaff,
      workedMin,
      scheduledMin,
      paidMin,
      payRate,
      cost,
      activityPct,
    };
  });

  const rows = rowsData
    .map((r) => {
      if (r.noHubstaff) {
        return `<tr>
          <td>${escape(r.name)}</td>
          <td style="text-align:right">${fmtMinutes(r.scheduledMin)}</td>
          <td colspan="3" style="text-align:center;color:#9ca3af">no Hubstaff data</td>
          <td style="text-align:right">${r.payRate ? `$${r.payRate}/hr` : "—"}</td>
          <td style="text-align:right">$0.00</td>
        </tr>`;
      }
      const overNote =
        r.workedMin != null && r.scheduledMin > 0 && r.workedMin > r.scheduledMin
          ? ` <span style="color:#9ca3af;font-size:11px">(actual ${fmtMinutes(r.workedMin)} capped)</span>`
          : "";
      return `<tr>
        <td>${escape(r.name)}</td>
        <td style="text-align:right">${fmtMinutes(r.scheduledMin)}</td>
        <td style="text-align:right">${fmtMinutes(r.workedMin)}</td>
        <td style="text-align:right;font-weight:600">${fmtMinutes(r.paidMin)}${overNote}</td>
        <td style="text-align:right">${r.activityPct}%</td>
        <td style="text-align:right">${r.payRate ? `$${r.payRate}/hr` : "—"}</td>
        <td style="text-align:right;font-weight:600">$${(r.cost || 0).toFixed(2)}</td>
      </tr>`;
    })
    .join("");

  // Totals row
  const totalScheduled = rowsData.reduce((s, r) => s + (r.scheduledMin || 0), 0);
  const totalWorked = rowsData.reduce(
    (s, r) => s + (r.workedMin != null ? r.workedMin : 0),
    0
  );
  const totalPaid = rowsData.reduce(
    (s, r) => s + (r.paidMin != null ? r.paidMin : 0),
    0
  );
  const totalCost = rowsData.reduce((s, r) => s + (r.cost || 0), 0);

  return `<section style="margin-bottom:24px">
    <h2 style="margin:0 0 12px;font-size:18px;color:#1b2435">1. Hubstaff Hours <span style="font-size:13px;color:#7a8294;font-weight:400">— ${dayCount} days</span></h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f5f7fb;text-align:left">
        <th style="padding:8px 10px">Employee</th>
        <th style="padding:8px 10px;text-align:right">Scheduled</th>
        <th style="padding:8px 10px;text-align:right">Worked</th>
        <th style="padding:8px 10px;text-align:right">Paid (capped)</th>
        <th style="padding:8px 10px;text-align:right">Activity %</th>
        <th style="padding:8px 10px;text-align:right">Pay rate</th>
        <th style="padding:8px 10px;text-align:right">Cost</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="7" style="padding:14px;color:#7a8294">No Hubstaff data for this range.</td></tr>`}
        <tr style="background:#f5f7fb;font-weight:700">
          <td style="padding:8px 10px">TOTAL</td>
          <td style="padding:8px 10px;text-align:right">${fmtMinutes(totalScheduled)}</td>
          <td style="padding:8px 10px;text-align:right">${fmtMinutes(totalWorked)}</td>
          <td style="padding:8px 10px;text-align:right">${fmtMinutes(totalPaid)}</td>
          <td></td>
          <td></td>
          <td style="padding:8px 10px;text-align:right">$${totalCost.toFixed(2)}</td>
        </tr>
      </tbody>
    </table>
    <div style="font-size:12px;color:#7a8294;margin-top:6px"><b>Pay formula:</b> <code>min(worked, scheduled paid hours) × rate</code> across the range. Scheduled paid hours = shift length − break budget, summed day-by-day (off-days contribute 0).</div>
  </section>`;
}

// ---------- Section 2 — Call Activity (aggregated) ----------
// Sums per-dispatcher buckets to get range totals.
function renderCallActivityAggregated(dispatch, { from, to }) {
  const dayCount = daysInRange(from, to);
  const byD = dispatch.byDispatcher || [];
  let real = 0, voicemail = 0, attempt = 0, liveTransfers = 0, sms = 0;
  for (const d of byD) {
    real += (d.real || 0) + (d.vonage?.real || 0);
    voicemail += (d.voicemail || 0) + (d.vonage?.voicemail || 0);
    attempt += (d.attempt || 0) + (d.vonage?.attempt || 0);
    liveTransfers += d.liveTransfers || 0;
    sms += d.sms || 0;
  }
  // Bookings come from dispatch.appointmentsBooked — the authoritative source
  // populated from Orlando/Tampa pipeline opps. Per-dispatcher attribution can
  // miss bookings whose assigned-to user isn't a tracked dispatcher (e.g.
  // INBOUND), so the total here is more honest than summing dispatcher rows.
  const allBooked = dispatch.appointmentsBooked || [];
  const bookings = allBooked.filter(
    (b) => b.kind === "physical" || b.kind === "phone_sale"
  );
  const physBookings = bookings.filter((b) => b.kind === "physical").length;
  const phoneBookings = bookings.filter((b) => b.kind === "phone_sale").length;
  const bookingsTotal = bookings.length;
  const totalCalls = real + voicemail + attempt;
  const avgPerDay = (n) => (dayCount ? (n / dayCount).toFixed(1) : "0");
  const avgResp = dispatch.avgResponseMinOverall;

  const stat = (label, total, color = "#1b2435") => `
    <div style="flex:1;min-width:140px;padding:12px 14px;background:#fff;border:1px solid #e0e6ee;border-radius:8px">
      <div style="font-size:11px;color:#7a8294;text-transform:uppercase;letter-spacing:0.5px;font-weight:600">${escape(label)}</div>
      <div style="font-size:24px;font-weight:700;color:${color};margin-top:4px">${total.toLocaleString()}</div>
      <div style="font-size:12px;color:#7a8294;margin-top:2px">avg ${avgPerDay(total)}/day</div>
    </div>`;

  const respStrip =
    avgResp != null
      ? `<div style="margin-top:12px;padding:10px 14px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;font-size:13px;color:#1e3a8a">
          <b>Avg Orlando-NEW response time:</b> ${avgResp.toFixed(1)} min
          (${dispatch.orlandoNewLeadsCount || 0} qualifying samples — leads added to the Orlando pipeline within 60 min of contact creation, with at least one outbound dispatcher call. NOT the total new-lead count.)
        </div>`
      : "";

  const bookingsStrip = `<div style="margin-top:12px;padding:10px 14px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;font-size:13px;color:#065f46">
    <b>Bookings:</b> ${bookingsTotal} total <span style="color:#047857">(${physBookings} Physical · ${phoneBookings} Phone)</span>
    <span style="color:#6b7280;margin-left:8px">avg ${avgPerDay(bookingsTotal)}/day across the range</span>
  </div>`;

  return `<section style="margin-bottom:24px">
    <h2 style="margin:0 0 12px;font-size:18px;color:#1b2435">2. Call Activity (range totals)</h2>
    <div style="display:flex;flex-wrap:wrap;gap:10px">
      ${stat("Total calls", totalCalls)}
      ${stat("Real (≥70s)", real, "#138a36")}
      ${stat("Live Transfers", liveTransfers, "#b45309")}
      ${stat("Voicemails", voicemail)}
      ${stat("Attempts", attempt)}
      ${stat("SMS", sms, "#991b1b")}
    </div>
    ${bookingsStrip}
    ${respStrip}
    <div style="font-size:12px;color:#7a8294;margin-top:6px">Bookings count comes from Orlando/Tampa pipeline opps (any status). The per-dispatcher column in Section 4 only attributes bookings whose assigned-to user is a tracked dispatcher; the total above is authoritative.</div>
  </section>`;
}

// ---------- Section 4 — Dispatcher Performance (aggregated) ----------
function renderDispatcherPerformanceAggregated(dispatch, { from, to }) {
  const dayCount = daysInRange(from, to);
  const rows = (dispatch.byDispatcher || [])
    .map((d) => {
      const real = (d.real || 0) + (d.vonage?.real || 0);
      const voicemail = (d.voicemail || 0) + (d.vonage?.voicemail || 0);
      const attempt = (d.attempt || 0) + (d.vonage?.attempt || 0);
      const total = real + voicemail + attempt;
      const liveTransfers = d.liveTransfers || 0;
      const bookings =
        (d.bookings != null
          ? d.bookings
          : (d.physBookings || 0) + (d.phBookings || 0));
      const avgCallDur = d.avgCallSec != null ? d.avgCallSec : 0;
      return `<tr>
        <td>${escape(d.name)}</td>
        <td style="text-align:right">${total}</td>
        <td style="text-align:right;color:#138a36;font-weight:600">${real}</td>
        <td style="text-align:right;color:#b45309">${liveTransfers}</td>
        <td style="text-align:right">${voicemail}</td>
        <td style="text-align:right">${attempt}</td>
        <td style="text-align:right">${bookings}</td>
        <td style="text-align:right">${fmtDur(avgCallDur)}</td>
        <td style="text-align:right;color:#7a8294">${dayCount ? (total / dayCount).toFixed(1) : "0"}/day</td>
      </tr>`;
    })
    .join("");

  return `<section style="margin-bottom:24px">
    <h2 style="margin:0 0 12px;font-size:18px;color:#1b2435">4. Dispatcher Performance (range)</h2>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead><tr style="background:#f5f7fb;text-align:left">
        <th style="padding:8px 10px">Dispatcher</th>
        <th style="padding:8px 10px;text-align:right">Total</th>
        <th style="padding:8px 10px;text-align:right">Real (≥70s)</th>
        <th style="padding:8px 10px;text-align:right">Live Tx</th>
        <th style="padding:8px 10px;text-align:right">VM</th>
        <th style="padding:8px 10px;text-align:right">Attempt</th>
        <th style="padding:8px 10px;text-align:right">Bookings</th>
        <th style="padding:8px 10px;text-align:right">Avg dur</th>
        <th style="padding:8px 10px;text-align:right">Per day</th>
      </tr></thead>
      <tbody>${rows || `<tr><td colspan="9" style="padding:14px;color:#7a8294">No dispatcher activity in this range.</td></tr>`}</tbody>
    </table>
    <div style="font-size:12px;color:#7a8294;margin-top:6px">Avg duration = mean of all real-call durations across the range.</div>
  </section>`;
}

// ---------- Section 5 — Hour × Dispatcher (aggregated totals + per-day note) ----------
// byDispatcher[i].hourly = [{ label, real, voicemail, attempt, sms, calls, attempts }]
function renderHourXDispatcherAggregated(dispatch, { from, to }) {
  const dayCount = daysInRange(from, to);
  const byDispatcher = dispatch.byDispatcher || [];
  if (byDispatcher.length === 0) return "";

  // Collect all hour labels seen across dispatchers (array of objects shape)
  const hourLabels = new Set();
  for (const d of byDispatcher) {
    const arr = Array.isArray(d.hourly) ? d.hourly : [];
    for (const slot of arr) {
      if (slot.label) hourLabels.add(slot.label);
    }
  }
  // Sort hour labels chronologically by parsing the leading hour number.
  const parseHour = (lbl) => {
    const m = String(lbl).match(/^(\d{1,2})\s*[–-]/);
    if (!m) return 99;
    let h = parseInt(m[1], 10);
    const isPM = /PM/i.test(lbl);
    if (isPM && h !== 12) h += 12;
    if (!isPM && h === 12) h = 0;
    return h;
  };
  const sortedHours = Array.from(hourLabels).sort(
    (a, b) => parseHour(a) - parseHour(b)
  );
  if (sortedHours.length === 0) return "";

  const headerCells = byDispatcher
    .map(
      (d) =>
        `<th style="padding:6px 8px;text-align:right">${escape(d.name.split(" ")[0])}</th>`
    )
    .join("");

  const rows = sortedHours
    .map((h) => {
      const cells = byDispatcher
        .map((d) => {
          const arr = Array.isArray(d.hourly) ? d.hourly : [];
          const slot = arr.find((s) => s.label === h) || {};
          const total =
            (slot.real || 0) + (slot.voicemail || 0) + (slot.attempt || 0);
          return `<td style="text-align:right;padding:5px 8px;${total === 0 ? "color:#c0c6d4" : ""}">${total}</td>`;
        })
        .join("");
      return `<tr><td style="padding:5px 8px;font-weight:600">${escape(h)}</td>${cells}</tr>`;
    })
    .join("");

  return `<section style="margin-bottom:24px">
    <h2 style="margin:0 0 4px;font-size:18px;color:#1b2435">5. Hour × Dispatcher (range total)</h2>
    <div style="font-size:12px;color:#7a8294;margin-bottom:10px">Each cell = total calls in that hour-of-day across <b>${dayCount} days</b>. Divide by ${dayCount} for daily average.</div>
    <table style="width:100%;border-collapse:collapse;font-size:13px">
      <thead><tr style="background:#f5f7fb;text-align:left">
        <th style="padding:6px 8px">Hour</th>${headerCells}
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

// ---------- Section 3/6 placeholder note ----------
function renderDetailNotAggregatedNote() {
  return `<section style="margin-bottom:24px;padding:14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px">
    <div style="font-weight:600;color:#854d0e;font-size:14px;margin-bottom:4px">Per-lead detail not aggregated</div>
    <div style="font-size:13px;color:#78350f">Lead Activity (Section 3) and Booking Funnel (Section 6) detail rows are per-day only. To inspect individual leads or booking trails, switch to Daily mode and pick a specific date.</div>
  </section>`;
}

// ---------- Top-level aggregator ----------
export async function buildAggregatedReport({ mode, from, to, generatedAt }) {
  const gen = generatedAt || DateTime.now().setZone(TZ);

  // Defensive: pad endpoints so the GHL/Hubstaff range covers full ET days.
  const fromDt = from.setZone(TZ).startOf("day");
  const toDt = to.setZone(TZ).endOf("day");

  const [hub, dispatch] = await Promise.all([
    buildHubstaffSection({
      from: fromDt,
      to: toDt,
      includeTotals: true,
    }).catch((e) => {
      console.error("[aggregate] hubstaff failed:", e?.message);
      return { perEmployee: [] };
    }),
    buildDispatcherSection({
      from: fromDt,
      to: toDt,
      includeTimeOfDay: false,
    }).catch((e) => {
      console.error("[aggregate] dispatcher failed:", e?.message);
      return { byDispatcher: [], totals: {} };
    }),
  ]);

  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:1100px;margin:0 auto;padding:8px">
    ${renderRangeHeader({ mode, from: fromDt, to: toDt, generatedAt: gen })}
    ${renderHubstaffAggregated(hub, { from: fromDt, to: toDt })}
    ${renderCallActivityAggregated(dispatch, { from: fromDt, to: toDt })}
    ${renderDispatcherPerformanceAggregated(dispatch, { from: fromDt, to: toDt })}
    ${renderHourXDispatcherAggregated(dispatch, { from: fromDt, to: toDt })}
    ${renderDetailNotAggregatedNote()}
  </div>`;

  return {
    html,
    summary: {
      mode,
      from: fromDt.toISO(),
      to: toDt.toISO(),
      dayCount: daysInRange(fromDt, toDt),
      hub,
      dispatch,
    },
  };
}

// Date-range resolver: turn UI inputs into a Luxon {from, to} range.
export function resolveRange({ mode, date, from, to, month }) {
  const tz = TZ;
  if (mode === "daily") {
    const d = (date
      ? DateTime.fromISO(date, { zone: tz })
      : DateTime.now().setZone(tz).minus({ days: 1 })
    ).startOf("day");
    return { from: d, to: d.endOf("day") };
  }
  if (mode === "weekly") {
    // "Week ending on date" — 7 days inclusive ending on selected date.
    const end = (date
      ? DateTime.fromISO(date, { zone: tz })
      : DateTime.now().setZone(tz).minus({ days: 1 })
    ).startOf("day");
    const start = end.minus({ days: 6 });
    return { from: start, to: end.endOf("day") };
  }
  if (mode === "monthly") {
    const m = month
      ? DateTime.fromISO(month + "-01", { zone: tz })
      : DateTime.now().setZone(tz).startOf("month");
    return { from: m.startOf("month"), to: m.endOf("month") };
  }
  if (mode === "custom") {
    const f = DateTime.fromISO(from, { zone: tz }).startOf("day");
    const t = DateTime.fromISO(to, { zone: tz }).endOf("day");
    return { from: f, to: t };
  }
  throw new Error(`Unknown dispatch mode: ${mode}`);
}
