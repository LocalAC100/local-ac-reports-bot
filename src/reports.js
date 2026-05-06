// Composes the morning (12 PM) and evening (7:30 PM) reports.
// Pulls data from Hubstaff + GHL, runs analysis, builds an HTML email,
// and ships it via mailer.

import { config } from "./config.js";
import { now, morningWindow, eveningWindow, hourBucket, fmtTime, TZ } from "./time.js";
import { EMPLOYEES, isDispatcher, expectedShiftFor } from "./employees.js";
import * as hubstaff from "./hubstaff.js";
import * as ghl from "./ghl.js";
import { analyzeScreenshots } from "./screenshots.js";
import { sendMail } from "./mailer.js";
import { renderEmail, renderHubstaffSection, renderDispatcherSection } from "./template.js";
import { DateTime } from "luxon";

// Threshold above which a "call" is considered real conversation, below it's an "attempt".
const CALL_THRESHOLD_SEC = 25;

// ---------- Hubstaff analysis ----------

async function buildHubstaffSection({ from, to, includeTotals }) {
  const fromIso = from.toUTC().toISO();
  const toIso = to.toUTC().toISO();

  const orgUsers = await hubstaff.listOrgUsers().catch(() => []);
  const userByEmail = new Map(
    orgUsers.map((u) => [(u.email || "").toLowerCase(), u])
  );

  const matched = EMPLOYEES.map((e) => {
    const hu = userByEmail.get((e.hubstaffEmail || "").toLowerCase());
    return { ...e, hubstaffUserId: hu?.id, hubstaffName: hu?.name };
  });
  const userIds = matched.map((m) => m.hubstaffUserId).filter(Boolean);

  const [activities, timesheets] = await Promise.all([
    hubstaff.getActivities({ from: fromIso, to: toIso, userIds }).catch(() => []),
    hubstaff.getTimesheets({ from: fromIso, to: toIso, userIds }).catch(() => []),
  ]);

  // Aggregate per-employee: hourly activity %, total tracked, clock in/out
  const perEmp = new Map();
  for (const e of matched) {
    if (!e.hubstaffUserId) continue;
    perEmp.set(e.hubstaffUserId, {
      employee: e,
      hourly: new Map(),
      totalTrackedSec: 0,
      totalActiveSec: 0,
      firstClockIn: null,
      lastClockOut: null,
    });
  }

  for (const a of activities) {
    const slot = perEmp.get(a.user_id);
    if (!slot) continue;
    const hour = hourBucket(DateTime.fromISO(a.starts_at || a.time_slot).setZone(TZ));
    const cur = slot.hourly.get(hour) || { trackedSec: 0, activeSec: 0 };
    cur.trackedSec += a.tracked || 0;
    cur.activeSec += (a.tracked || 0) * ((a.overall || 0) / 100);
    slot.hourly.set(hour, cur);
    slot.totalTrackedSec += a.tracked || 0;
    slot.totalActiveSec += (a.tracked || 0) * ((a.overall || 0) / 100);
  }

  // Clock-in / clock-out from timesheets
  for (const ts of timesheets) {
    const slot = perEmp.get(ts.user_id);
    if (!slot) continue;
    const start = ts.starts_at ? DateTime.fromISO(ts.starts_at).setZone(TZ) : null;
    const stop = ts.stops_at ? DateTime.fromISO(ts.stops_at).setZone(TZ) : null;
    if (start && (!slot.firstClockIn || start < slot.firstClockIn)) slot.firstClockIn = start;
    if (stop && (!slot.lastClockOut || stop > slot.lastClockOut)) slot.lastClockOut = stop;
  }

  // Discrepancies: scheduled today but no tracked time yet
  const today = now();
  const discrepancies = [];
  for (const e of matched) {
    if (!e.hubstaffUserId) continue;
    const shift = expectedShiftFor(e, today);
    if (!shift) continue;
    const slot = perEmp.get(e.hubstaffUserId);
    if (!slot || slot.totalTrackedSec < 60) {
      discrepancies.push({
        employee: e.name,
        detail: `scheduled ${shift.start}, no tracked time yet by ${to.toFormat("h:mm a")}`,
      });
    }
  }

  // Per-employee detail rows (the heart of the new section 1)
  const perEmployee = [];
  for (const e of matched) {
    if (!e.hubstaffUserId) continue;
    const slot = perEmp.get(e.hubstaffUserId);
    if (!slot) continue;
    const workedMinutes = slot.totalTrackedSec / 60;
    const activityPct = slot.totalTrackedSec
      ? Math.round((slot.totalActiveSec / slot.totalTrackedSec) * 100)
      : 0;
    // Break = (clockOut - clockIn) - tracked. Approximate.
    let breakMinutes = null;
    if (slot.firstClockIn && slot.lastClockOut) {
      const shiftMin = slot.lastClockOut.diff(slot.firstClockIn, "minutes").minutes;
      breakMinutes = Math.max(0, shiftMin - workedMinutes);
    }
    const breakBudget = e.breakMinutesPerShift ?? 0;
    const breakOver = breakMinutes != null && breakMinutes > breakBudget + 5; // 5-min grace

    let statusFlag = null;
    const shift = expectedShiftFor(e, today);
    if (!slot.firstClockIn && shift) {
      statusFlag = { text: "no clock-in", color: "amber" };
    } else if (workedMinutes < 60 && shift) {
      statusFlag = { text: "under 1h tracked", color: "amber" };
    } else if (activityPct > 0 && activityPct < 40) {
      statusFlag = { text: "low activity", color: "red" };
    } else if (breakOver) {
      statusFlag = { text: `break over (${Math.round(breakMinutes - breakBudget)}m extra)`, color: "amber" };
    }

    perEmployee.push({
      name: e.name,
      role: e.role,
      clockIn: slot.firstClockIn ? slot.firstClockIn.toFormat("h:mm a") : null,
      clockOut: slot.lastClockOut && slot.lastClockOut < now() ? slot.lastClockOut.toFormat("h:mm a") : (slot.firstClockIn ? "still on" : null),
      workedMinutes,
      breakMinutes,
      breakOver,
      activityPct,
      activityFlag: activityPct > 0 && activityPct < 40,
      statusFlag,
    });
  }

  // Hourly low-activity flags (vs employee's own avg)
  const lowActivityFlags = [];
  for (const [, slot] of perEmp) {
    const e = slot.employee;
    const hours = [...slot.hourly.entries()].sort();
    const avgPct = slot.totalTrackedSec
      ? Math.round((slot.totalActiveSec / slot.totalTrackedSec) * 100)
      : 0;
    for (const [h, v] of hours) {
      const pct = v.trackedSec ? Math.round((v.activeSec / v.trackedSec) * 100) : 0;
      if (avgPct > 0 && pct > 0 && pct < avgPct - 20) {
        lowActivityFlags.push({
          employee: e.name,
          hour: h,
          detail: `${pct}% (own avg ${avgPct}%)`,
          alsoLowCalls: false,
        });
      }
    }
  }

  // Screenshot manipulation detection
  const manipulationFlags = [];
  if (userIds.length) {
    const screenshots = await hubstaff
      .getScreenshots({ from: fromIso, to: toIso, userIds })
      .catch(() => []);
    const byUser = new Map();
    for (const s of screenshots) {
      const arr = byUser.get(s.user_id) || [];
      arr.push(s);
      byUser.set(s.user_id, arr);
    }
    for (const [, slot] of perEmp) {
      const empShots = byUser.get(slot.employee.hubstaffUserId) || [];
      if (empShots.length < 3) continue;
      const activityByHourPct = Object.fromEntries(
        [...slot.hourly.entries()].map(([h, v]) => [
          h,
          v.trackedSec ? (v.activeSec / v.trackedSec) * 100 : 0,
        ])
      );
      const { flags } = await analyzeScreenshots(empShots, activityByHourPct);
      for (const f of flags) {
        manipulationFlags.push({
          employee: slot.employee.name,
          windowLabel: `${fmtTime(DateTime.fromISO(f.windowStart))} – ${fmtTime(DateTime.fromISO(f.windowEnd))}`,
          reason: f.reason,
        });
      }
    }
  }

  let totalsByEmployee;
  if (includeTotals) {
    totalsByEmployee = matched
      .filter((e) => e.hubstaffUserId)
      .map((e) => {
        const slot = perEmp.get(e.hubstaffUserId);
        const minutes = (slot?.totalTrackedSec ?? 0) / 60;
        return {
          employee: e.name,
          minutes,
          payRate: e.payRate,
          cost: (minutes / 60) * e.payRate,
        };
      });
  }

  return {
    perEmployee,
    discrepancies,
    lowActivityFlags,
    manipulationFlags,
    totalsByEmployee,
    _byUser: perEmp,
  };
}

// ---------- GHL dispatcher analysis ----------

// Time-of-day buckets (evening report only).
// Morning until 12 PM, Noon 12-4 PM, Afternoon 4-9 PM (all ET).
const BUCKETS = [
  { key: "morning", label: "Morning", hours: "until 12 PM", startHour: 0, endHour: 12 },
  { key: "noon", label: "Noon", hours: "12 PM – 4 PM", startHour: 12, endHour: 16 },
  { key: "afternoon", label: "Afternoon", hours: "4 PM – 9 PM", startHour: 16, endHour: 21 },
];

async function buildDispatcherSection({ from, to, includeTimeOfDay }) {
  const fromIso = from.toUTC().toISO();
  const toIso = to.toUTC().toISO();

  const [pipelines, conversations, ghlUsers] = await Promise.all([
    ghl.listPipelines().catch(() => []),
    ghl.searchConversations({ from: fromIso, to: toIso, limit: 100 }).catch(() => []),
    ghl.listUsers().catch(() => []),
  ]);

  const dispatcherEmployees = EMPLOYEES.filter(isDispatcher);
  const ghlByEmail = new Map(
    ghlUsers.map((u) => [(u.email || "").toLowerCase(), u])
  );

  const byDispatcher = new Map();
  for (const e of dispatcherEmployees) {
    const ghlEmail = (e.ghlEmail || e.hubstaffEmail || "").toLowerCase();
    const ghlUser = ghlByEmail.get(ghlEmail);
    byDispatcher.set(e.name, {
      name: e.name,
      ghlUserId: ghlUser?.id,
      calls: 0,
      attempts: 0,
      bookings: 0,
      callDurationsSec: [],
      hourly: new Map(),
      // bucket totals (evening only)
      buckets: { morning: { calls: 0, attempts: 0 }, noon: { calls: 0, attempts: 0 }, afternoon: { calls: 0, attempts: 0 } },
    });
  }

  // Bucket helper: which time-of-day bucket does a Date fall in (ET hour)
  function bucketFor(dt) {
    const h = dt.setZone(TZ).hour;
    if (h < 12) return "morning";
    if (h < 16) return "noon";
    return "afternoon";
  }

  // Pull all messages from each conversation, count calls vs attempts, bucket per hour
  for (const conv of conversations) {
    const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
    for (const m of msgs) {
      if (String(m.type ?? "").toUpperCase() !== "CALL") continue;
      const userId = m.userId || m.user || m.createdBy;
      const dispatcher = [...byDispatcher.values()].find((d) => d.ghlUserId === userId);
      if (!dispatcher) continue;
      const dur = m.callDuration ?? m.duration ?? 0;
      const isCall = dur >= CALL_THRESHOLD_SEC;
      if (isCall) {
        dispatcher.calls += 1;
        dispatcher.callDurationsSec.push(dur);
      } else {
        dispatcher.attempts += 1;
      }

      const dt = DateTime.fromISO(m.dateAdded || m.createdAt || new Date().toISOString()).setZone(TZ);
      const hourKey = hourBucket(dt);
      const slot = dispatcher.hourly.get(hourKey) || { calls: 0, attempts: 0 };
      if (isCall) slot.calls += 1;
      else slot.attempts += 1;
      dispatcher.hourly.set(hourKey, slot);

      if (includeTimeOfDay) {
        const b = bucketFor(dt);
        if (isCall) dispatcher.buckets[b].calls += 1;
        else dispatcher.buckets[b].attempts += 1;
      }
    }
  }

  // Appointments booked / Over Phone Sale
  const appointmentsBooked = [];
  const bucketBookings = { morning: 0, noon: 0, afternoon: 0 };
  for (const p of pipelines) {
    const opps = await ghl
      .searchOpportunities({ pipelineId: p.id, status: "open" })
      .catch(() => []);
    for (const o of opps) {
      const stage = String(o.pipelineStageName ?? "").toLowerCase();
      const updated = DateTime.fromISO(o.updatedAt || o.dateAdded || new Date().toISOString()).setZone(TZ);
      if (updated < from || updated > to) continue;
      if (stage.includes("appointment booked") || stage.includes("over phone sale")) {
        const dispatcher =
          [...byDispatcher.values()].find((d) => d.ghlUserId === o.assignedTo) || { name: "—" };
        if (dispatcher.bookings != null) dispatcher.bookings += 1;
        appointmentsBooked.push({
          leadName: o.contact?.name || o.name || "(unnamed)",
          time: fmtTime(updated),
          dispatcher: dispatcher.name,
          stage: o.pipelineStageName,
        });
        if (includeTimeOfDay) bucketBookings[bucketFor(updated)] += 1;
      }
    }
  }

  // New-lead response time
  const newLeads = await ghl
    .searchContacts({ from: fromIso, to: toIso, limit: 100 })
    .catch(() => []);
  const responseTimeAlerts = [];
  for (const c of newLeads) {
    const created = DateTime.fromISO(c.dateAdded).setZone(TZ);
    let firstCallAt = null;
    let firstCallBy = null;
    const conv = conversations.find((cv) => cv.contactId === c.id);
    if (conv) {
      const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
      const calls = msgs
        .filter((m) => String(m.type ?? "").toUpperCase() === "CALL")
        .filter((m) => String(m.direction ?? "").toLowerCase() === "outbound");
      if (calls.length) {
        calls.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
        firstCallAt = DateTime.fromISO(calls[0].dateAdded).setZone(TZ);
        const userId = calls[0].userId;
        firstCallBy = [...byDispatcher.values()].find((d) => d.ghlUserId === userId)?.name;
      }
    }
    const delayMinutes = firstCallAt
      ? firstCallAt.diff(created, "minutes").minutes
      : now().diff(created, "minutes").minutes;
    const late = delayMinutes > config.leadResponseThresholdMinutes;
    responseTimeAlerts.push({
      leadName:
        `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() ||
        c.contactName ||
        c.email ||
        "(unnamed lead)",
      dispatcher: firstCallBy,
      delayMinutes,
      late,
    });
  }

  // Build per-dispatcher final shape (sorted hourly, with avg call duration)
  const byDispatcherOut = [];
  for (const d of byDispatcher.values()) {
    const hourly = [...d.hourly.entries()].sort().map(([k, v]) => ({
      label: formatHourLabel(k),
      calls: v.calls,
      attempts: v.attempts,
    }));
    const avgCallSec = d.callDurationsSec.length
      ? d.callDurationsSec.reduce((a, b) => a + b, 0) / d.callDurationsSec.length
      : null;
    byDispatcherOut.push({
      name: d.name,
      calls: d.calls,
      attempts: d.attempts,
      bookings: d.bookings,
      avgCallSec,
      hourly,
    });
  }

  // Time-of-day summary (evening only)
  let timeOfDay;
  if (includeTimeOfDay) {
    timeOfDay = BUCKETS.map((b) => {
      let calls = 0, attempts = 0;
      for (const d of byDispatcher.values()) {
        calls += d.buckets[b.key].calls;
        attempts += d.buckets[b.key].attempts;
      }
      const bookings = bucketBookings[b.key];
      // Verdict heuristic
      let verdict, note;
      if (calls === 0 && attempts === 0) {
        verdict = "low";
        note = "No call activity";
      } else if (calls < attempts) {
        verdict = "low";
        note = "More attempts than calls";
      } else if (calls >= attempts && bookings > 0) {
        verdict = "good";
        note = `${bookings} booking${bookings === 1 ? "" : "s"}`;
      } else {
        verdict = "ok";
        note = null;
      }
      return { ...b, calls, attempts, bookings, verdict, note };
    });
  }

  return {
    byDispatcher: byDispatcherOut,
    responseTimeAlerts,
    appointmentsBooked,
    timeOfDay,
  };
}

function formatHourLabel(hh00) {
  // "08:00" → "8 – 9 AM", "13:00" → "1 – 2 PM"
  const h = parseInt(hh00.split(":")[0], 10);
  const start = h % 12 === 0 ? 12 : h % 12;
  const endH = (h + 1) % 24;
  const end = endH % 12 === 0 ? 12 : endH % 12;
  const ampmStart = h < 12 ? "AM" : "PM";
  const ampmEnd = endH < 12 ? "AM" : "PM";
  return ampmStart === ampmEnd ? `${start} – ${end} ${ampmStart}` : `${start} ${ampmStart} – ${end} ${ampmEnd}`;
}

// ---------- Top-level orchestrators ----------

export async function runMorningReport() {
  const generatedAt = now();
  const { from, to } = morningWindow(generatedAt);

  const hub = await buildHubstaffSection({ from, to, includeTotals: false });
  const dispatch = await buildDispatcherSection({ from, to, includeTimeOfDay: false });

  // Cross-reference low activity AND low calls
  const dispatcherByName = new Map(dispatch.byDispatcher.map((d) => [d.name, d]));
  for (const f of hub.lowActivityFlags) {
    const d = dispatcherByName.get(f.employee);
    if (!d) continue;
    const hourly = d.hourly.find((h) => formatHourLabel(f.hour) === h.label);
    if (hourly && hourly.calls + hourly.attempts <= 1) f.alsoLowCalls = true;
  }

  const html = renderEmail({
    title: "Morning Snapshot",
    generatedAt,
    sections: [renderHubstaffSection(hub), renderDispatcherSection(dispatch)],
  });

  await sendMail({
    subject: `Local AC — Morning Snapshot (${generatedAt.toFormat("LLL d")})`,
    html,
  });
}

export async function runEveningReport() {
  const generatedAt = now();
  const { from, to } = eveningWindow(generatedAt);

  const hub = await buildHubstaffSection({ from, to, includeTotals: true });
  const dispatch = await buildDispatcherSection({ from, to, includeTimeOfDay: true });

  const dispatcherByName = new Map(dispatch.byDispatcher.map((d) => [d.name, d]));
  for (const f of hub.lowActivityFlags) {
    const d = dispatcherByName.get(f.employee);
    if (!d) continue;
    const hourly = d.hourly.find((h) => formatHourLabel(f.hour) === h.label);
    if (hourly && hourly.calls + hourly.attempts <= 1) f.alsoLowCalls = true;
  }

  const html = renderEmail({
    title: "Full Day Summary",
    generatedAt,
    sections: [renderHubstaffSection(hub), renderDispatcherSection(dispatch)],
  });

  await sendMail({
    subject: `Local AC — Full Day Summary (${generatedAt.toFormat("LLL d")})`,
    html,
  });
}

// ---------- Test-mode (random sample data) ----------

export async function runTestReport() {
  const generatedAt = now();

  const hub = sampleHub();
  const dispatch = sampleDispatch();

  const html = renderEmail({
    title: "Sample Full Day Summary (test)",
    generatedAt,
    sections: [renderHubstaffSection(hub), renderDispatcherSection(dispatch)],
  });

  await sendMail({
    subject: `Local AC — TEST report preview (${generatedAt.toFormat("LLL d, h:mm a")})`,
    html,
  });
}

function sampleHub() {
  return {
    perEmployee: [
      { name: "Chris", role: "office_manager", clockIn: "8:02 AM", clockOut: "8:55 PM", workedMinutes: 720, breakMinutes: 58, activityPct: 84, statusFlag: null },
      { name: "Frank", role: "dispatcher_manager", clockIn: "7:01 AM", clockOut: "7:48 PM", workedMinutes: 705, breakMinutes: 62, activityPct: 79, statusFlag: null },
      { name: "Ellie", role: "dispatcher", clockIn: "2:30 PM", clockOut: "8:01 PM", workedMinutes: 305, breakMinutes: 26, activityPct: 71, statusFlag: null },
      { name: "Angel", role: "dispatcher", clockIn: "8:14 AM", clockOut: "2:30 PM", workedMinutes: 358, breakMinutes: 38, breakOver: true, activityPct: 38, activityFlag: true, statusFlag: { text: "low activity", color: "red" } },
    ],
    discrepancies: [],
    lowActivityFlags: [
      { employee: "Angel", hour: "11:00", detail: "32% (own avg 64%)", alsoLowCalls: true },
    ],
    manipulationFlags: [],
    totalsByEmployee: [
      { employee: "Chris", minutes: 720, payRate: 5, cost: 60 },
      { employee: "Frank", minutes: 705, payRate: 4, cost: 47 },
      { employee: "Ellie", minutes: 305, payRate: 4, cost: 20.33 },
      { employee: "Angel", minutes: 358, payRate: 4, cost: 23.87 },
    ],
  };
}

function sampleDispatch() {
  const sampleHourly = (base) => [
    { label: "8 – 9 AM", calls: base + 1, attempts: 2 },
    { label: "9 – 10 AM", calls: base + 3, attempts: 4 },
    { label: "10 – 11 AM", calls: base + 2, attempts: 3 },
    { label: "11 – 12 PM", calls: base + 4, attempts: 1 },
    { label: "12 – 1 PM", calls: base, attempts: 2 },
    { label: "1 – 2 PM", calls: base + 1, attempts: 2 },
    { label: "2 – 3 PM", calls: base + 2, attempts: 1 },
    { label: "3 – 4 PM", calls: base + 1, attempts: 3 },
    { label: "4 – 5 PM", calls: base + 2, attempts: 2 },
    { label: "5 – 6 PM", calls: base + 1, attempts: 1 },
  ];
  return {
    byDispatcher: [
      { name: "Frank", calls: 32, attempts: 18, bookings: 6, avgCallSec: 142, hourly: sampleHourly(2) },
      { name: "Ellie", calls: 21, attempts: 14, bookings: 4, avgCallSec: 168, hourly: sampleHourly(1) },
      { name: "Angel", calls: 14, attempts: 11, bookings: 2, avgCallSec: 119, hourly: sampleHourly(1) },
    ],
    timeOfDay: [
      { label: "Morning", hours: "until 12 PM", calls: 28, attempts: 14, bookings: 5, verdict: "good", note: "5 bookings" },
      { label: "Noon", hours: "12 PM – 4 PM", calls: 22, attempts: 12, bookings: 4, verdict: "good", note: "4 bookings" },
      { label: "Afternoon", hours: "4 PM – 9 PM", calls: 17, attempts: 17, bookings: 3, verdict: "low", note: "More attempts than calls" },
    ],
    responseTimeAlerts: [
      { leadName: "Maria Sanchez", dispatcher: "Frank", delayMinutes: 1.5, late: false },
      { leadName: "John Doe", dispatcher: null, delayMinutes: 8.2, late: true },
      { leadName: "Carlos Ruiz", dispatcher: "Ellie", delayMinutes: 2.1, late: false },
    ],
    appointmentsBooked: [
      { leadName: "Maria Sanchez", time: "9:14 AM", dispatcher: "Frank", stage: "Appointment Booked" },
      { leadName: "Carlos Ruiz", time: "11:42 AM", dispatcher: "Ellie", stage: "Over Phone Sale" },
      { leadName: "Jennifer Park", time: "2:08 PM", dispatcher: "Frank", stage: "Appointment Booked" },
    ],
  };
}
