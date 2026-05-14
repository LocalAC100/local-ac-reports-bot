// Real-time dispatcher-idle alert (v3 — Hubstaff-break-aware, exclusion-aware).
//
// Every 5 min during business hours (8 AM – 9 PM ET), scan on-shift dispatchers
// who are NOT flagged `idleAlertsExcluded`. Fire an alert for anyone who hasn't
// placed an OUTBOUND CALL in IDLE_THRESHOLD_MIN minutes during their scheduled
// shift today AND who is NOT currently on a Hubstaff break.
//
// Per Alex's v20 spec (locked May 14 2026):
//   - Trigger: zero outbound calls for 15 min during scheduled shift today
//   - Excluded: Frank Maglanoc (dispatcher_manager), Chris (office_manager) —
//     both via `idleAlertsExcluded: true` in employees.js
//   - Hubstaff break gate: if the dispatcher is currently on break in Hubstaff
//     (no active timesheet right now), HOLD the alert. We do NOT subtract total
//     break minutes from the window — that was an earlier idea, rejected.
//   - Recipient: service@local-ac.com
//
// Idle anchor: idle = now − max(last_call_today_in_shift, shift_start_today).
// This eliminates the "1,211-min idle" false alerts that the v1 logic produced
// when it compared to a global last_activity.
//
// 30-min cooldown per dispatcher so the same person doesn't get re-alerted
// every 5 min while still idle.
//
// checkIdleDispatchers() returns a diagnostic object so the /admin/debug/check-idle
// endpoint can render it as JSON for testing without spamming the inbox.

import { DateTime } from "luxon";
import * as ghl from "./ghl.js";
import * as hubstaff from "./hubstaff.js";
import { EMPLOYEES, isDispatcher, expectedShiftFor } from "./employees.js";
import { sendMail } from "./mailer.js";
import { Alerts, Calls } from "./db.js";

const TZ = "America/New_York";
const IDLE_THRESHOLD_MIN = 15; // default — override via emp.idleThresholdMin
const COOLDOWN_MIN = 30;
const ALERT_RECIPIENT = "service@local-ac.com";

function thresholdFor(emp) {
  return Number(emp?.idleThresholdMin) || IDLE_THRESHOLD_MIN;
}

// Per-employee state: { lastEventAt, lastAlertAt }
const state = new Map();

function shiftWindowToday(emp, now) {
  const shift = expectedShiftFor(emp, now);
  if (!shift) return null;
  const [sh, sm] = shift.start.split(":").map(Number);
  const [eh, em] = shift.end.split(":").map(Number);
  const start = now.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = now.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  return { shift, start, end };
}

// Hubstaff "on break" detection — uses today's timesheets.
//
// Hubstaff's API doesn't expose a real-time on_break flag, so we infer it:
//   - "Active" = the user has a CURRENTLY-OPEN timesheet (started today,
//     not yet stopped, OR a closed timesheet whose stops_at is within the
//     last 2 minutes — covers the brief gap between auto-segments).
//   - "On break" = there is at least one timesheet for today (they did clock
//     in at some point) BUT none of them are currently open.
//   - "Never started" = no timesheets for today at all → NOT on break; the
//     idle alert should still fire.
//
// Returns { onBreak: bool, reason: string, openSheet: bool, sheetCount: int }
async function checkHubstaffBreak(emp, now) {
  if (!emp?.hubstaffUserId) {
    return { onBreak: false, reason: "no hubstaff user id", sheetCount: 0, openSheet: false };
  }
  const dayStart = now.startOf("day").toUTC().toISO();
  const lookAhead = now.plus({ hours: 1 }).toUTC().toISO(); // catch ongoing
  let sheets = [];
  try {
    sheets = await hubstaff.getTimesheets({
      from: dayStart,
      to: lookAhead,
      userIds: [emp.hubstaffUserId],
    });
  } catch (e) {
    // If Hubstaff is unreachable, fall through to "not on break" so we don't
    // silently miss alerts. The error is logged for visibility.
    console.error(`[idle] hubstaff getTimesheets failed for ${emp.name}:`, e?.message);
    return { onBreak: false, reason: "hubstaff fetch failed", sheetCount: 0, openSheet: false, error: e?.message };
  }

  const nowMs = now.toMillis();
  const TWO_MIN_MS = 2 * 60 * 1000;

  let openSheet = false;
  let mostRecentStop = null;
  for (const s of sheets) {
    const startStr = s.starts_at || s.start_time || s.time?.start;
    const stopStr = s.stops_at || s.stop_time || s.time?.stop;
    const startMs = startStr ? new Date(startStr).getTime() : null;
    const stopMs = stopStr ? new Date(stopStr).getTime() : null;

    if (startMs && startMs <= nowMs && (stopMs === null || stopMs > nowMs - TWO_MIN_MS)) {
      openSheet = true;
    }
    if (stopMs && (mostRecentStop === null || stopMs > mostRecentStop)) {
      mostRecentStop = stopMs;
    }
  }

  if (openSheet) {
    return { onBreak: false, reason: "active timesheet", sheetCount: sheets.length, openSheet: true };
  }
  if (sheets.length === 0) {
    return { onBreak: false, reason: "no timesheets today (never clocked in)", sheetCount: 0, openSheet: false };
  }
  // Has timesheets today, none currently open → on break.
  return {
    onBreak: true,
    reason: "no open timesheet right now",
    sheetCount: sheets.length,
    openSheet: false,
    mostRecentStopAt: mostRecentStop ? new Date(mostRecentStop).toISOString() : null,
  };
}

// Main entry.
//   opts.dryRun = true  → skip sendMail / Alerts.log; still return diagnostics
//   opts.sendMail = false → skip sendMail (alias for dryRun's mail bit)
//
// Returns { now, onShift, evaluated: [{...per-dispatcher...}], skipped: [...] }.
export async function checkIdleDispatchers(opts = {}) {
  const dryRun = !!opts.dryRun;
  const now = DateTime.now().setZone(TZ);
  const diag = {
    now: now.toISO(),
    nowFmt: now.toFormat("yyyy-LL-dd h:mm a") + " ET",
    dryRun,
    evaluated: [],
    skipped: [],
    fired: 0,
    suppressedByBreak: 0,
    suppressedByCooldown: 0,
  };

  // Find on-shift dispatchers, skipping excluded ones.
  const onShift = [];
  for (const e of EMPLOYEES) {
    if (!isDispatcher(e)) continue;
    if (e.idleAlertsExcluded) {
      diag.skipped.push({ name: e.name, reason: "idleAlertsExcluded" });
      continue;
    }
    if (!e.ghlEmail) {
      diag.skipped.push({ name: e.name, reason: "no ghlEmail" });
      continue;
    }
    const win = shiftWindowToday(e, now);
    if (!win) {
      diag.skipped.push({ name: e.name, reason: "no shift today" });
      continue;
    }
    if (now < win.start || now >= win.end) {
      diag.skipped.push({
        name: e.name,
        reason: `outside shift (${win.shift.start}-${win.shift.end})`,
      });
      continue;
    }
    onShift.push({ emp: e, ...win });
  }

  if (!onShift.length) {
    console.log(`[idle] no dispatchers on shift @ ${now.toFormat("h:mm a")}`);
    return diag;
  }

  // GHL email → user_id map (so we can filter the calls table by this dispatcher).
  let ghlUsers = [];
  try {
    ghlUsers = await ghl.listUsers();
  } catch (e) {
    console.error("[idle] listUsers failed:", e?.message);
    diag.ghlUsersError = e?.message;
  }
  const userIdByEmail = new Map(
    ghlUsers.map((u) => [(u.email || "").toLowerCase(), u.id])
  );

  // Pull all outbound calls in the union of all on-shift windows up to now.
  const earliestStart = onShift.reduce(
    (min, x) => (x.start < min ? x.start : min),
    onShift[0].start
  );
  const fromIso = earliestStart.toUTC().toISO();
  const toIso = now.toUTC().toISO();
  const allCalls = Calls.listInWindow(fromIso, toIso, 5000);
  const outboundCalls = allCalls.filter(
    (r) => (r.direction || "").toLowerCase() === "outbound"
  );

  for (const { emp, shift, start } of onShift) {
    const row = {
      name: emp.name,
      fullName: emp.fullName,
      shiftStart: shift.start,
      shiftEnd: shift.end,
    };

    const userId = userIdByEmail.get((emp.ghlEmail || "").toLowerCase());
    if (!userId) {
      console.log(
        `[idle] ${emp.name} — no GHL user_id mapping for ${emp.ghlEmail}, skipping`
      );
      row.skipped = `no GHL user_id mapping for ${emp.ghlEmail}`;
      diag.evaluated.push(row);
      continue;
    }
    row.ghlUserId = userId;

    // Last outbound call by this dispatcher inside today's shift window.
    const startIso = start.toUTC().toISO();
    let lastEventAt = null;
    for (const c of outboundCalls) {
      if (c.user_id !== userId) continue;
      if (c.date_added < startIso) continue;
      const dt = DateTime.fromISO(c.date_added).setZone(TZ);
      if (!dt.isValid) continue;
      if (!lastEventAt || dt > lastEventAt) lastEventAt = dt;
    }

    // If no calls yet, idle is measured from shift start.
    const referenceTime = lastEventAt || start;
    const idleMin = Math.round(now.diff(referenceTime, "minutes").minutes);
    row.lastEventAt = lastEventAt ? lastEventAt.toISO() : null;
    row.lastEventAtFmt = lastEventAt ? lastEventAt.toFormat("h:mm a") : null;
    row.idleMin = idleMin;
    row.referenceTime = referenceTime.toISO();

    const lastAlertAt = state.get(emp.name)?.lastAlertAt;
    const inCooldown =
      lastAlertAt && now.diff(lastAlertAt, "minutes").minutes < COOLDOWN_MIN;
    row.inCooldown = !!inCooldown;
    if (lastAlertAt) row.lastAlertAt = lastAlertAt.toISO();

    const threshold = thresholdFor(emp);
    row.threshold = threshold;

    if (idleMin < threshold) {
      // Not idle enough yet — nothing to do.
      state.set(emp.name, { lastEventAt, lastAlertAt });
      row.action = "ok-below-threshold";
      console.log(
        lastEventAt
          ? `[idle] ${emp.name} OK (silent ${idleMin}m, last ${lastEventAt.toFormat("h:mm a")})`
          : `[idle] ${emp.name} OK (no calls yet, ${idleMin}m since shift start)`
      );
      diag.evaluated.push(row);
      continue;
    }

    if (inCooldown) {
      state.set(emp.name, { lastEventAt, lastAlertAt });
      row.action = "suppressed-cooldown";
      diag.suppressedByCooldown++;
      console.log(
        `[idle] ${emp.name} idle ${idleMin}m but in cooldown until ${lastAlertAt
          .plus({ minutes: COOLDOWN_MIN })
          .toFormat("h:mm a")}`
      );
      diag.evaluated.push(row);
      continue;
    }

    // Check Hubstaff break status before firing.
    const breakInfo = await checkHubstaffBreak(emp, now);
    row.hubstaff = breakInfo;
    if (breakInfo.onBreak) {
      state.set(emp.name, { lastEventAt, lastAlertAt });
      row.action = "suppressed-hubstaff-break";
      diag.suppressedByBreak++;
      console.log(
        `[idle] ${emp.name} idle ${idleMin}m but ON BREAK in Hubstaff (${breakInfo.reason}), holding alert`
      );
      diag.evaluated.push(row);
      continue;
    }

    // Fire it.
    row.action = dryRun ? "would-fire" : "fired";
    diag.fired++;
    if (dryRun) {
      console.log(
        `[idle] DRY-RUN would fire for ${emp.name} (idle ${idleMin}m, threshold ${threshold}m)`
      );
      state.set(emp.name, { lastEventAt, lastAlertAt }); // don't update cooldown
      diag.evaluated.push(row);
      continue;
    }

    const html = renderIdleAlertHtml({
      dispatcher: emp.name,
      silentMin: idleMin,
      lastEventAt,
      shiftStart: shift.start,
      hubstaff: breakInfo,
    });
    try {
      await sendMail({
        to: ALERT_RECIPIENT,
        subject: `🔴 ${emp.name} idle for ${idleMin} min — no outbound calls`,
        html,
      });
      Alerts.log({
        contactId: `idle-${emp.name}-${now.toMillis()}`,
        contactName: `(idle: ${emp.name})`,
        phone: null,
        leadAddedAt: now.toISO(),
        minutesElapsed: idleMin,
        level: 1,
      });
      console.log(
        `[idle] FIRED ${emp.name} silent ${idleMin}m last=${
          lastEventAt ? lastEventAt.toFormat("h:mm a") : "no calls yet"
        }`
      );
    } catch (err) {
      console.error("[idle] send failed", err?.message);
      row.sendError = err?.message;
    }
    state.set(emp.name, { lastEventAt, lastAlertAt: now });
    diag.evaluated.push(row);
  }

  return diag;
}

function renderIdleAlertHtml({ dispatcher, silentMin, lastEventAt, shiftStart, hubstaff }) {
  const lastStr = lastEventAt
    ? lastEventAt.toFormat("h:mm a") + " ET"
    : "(no outbound calls since shift started)";
  const hsLine =
    hubstaff && hubstaff.reason
      ? `Hubstaff: ${hubstaff.reason}${
          hubstaff.sheetCount ? ` (${hubstaff.sheetCount} timesheet${hubstaff.sheetCount === 1 ? "" : "s"} today)` : ""
        }`
      : "";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FEF2F2;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1F2937">
<div style="max-width:600px;margin:0 auto;padding:24px 18px">
<div style="background:#DC2626;color:#fff;border-radius:12px;padding:16px 20px;margin-bottom:14px">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;opacity:.85">Idle alert</div>
<div style="font-size:18px;font-weight:700;line-height:1.2">🔴 ${dispatcher} idle for ${silentMin} minutes</div>
</div>
<div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px 22px">
<table style="font-size:14px;line-height:1.7;width:100%">
<tr><td style="color:#6B7280;width:40%">Dispatcher</td><td><strong>${dispatcher}</strong></td></tr>
<tr><td style="color:#6B7280">Last outbound call</td><td>${lastStr}</td></tr>
<tr><td style="color:#6B7280">Silent for</td><td><strong style="color:#DC2626">${silentMin} minutes</strong></td></tr>
<tr><td style="color:#6B7280">Shift starts</td><td>${shiftStart}</td></tr>
${hsLine ? `<tr><td style="color:#6B7280">Hubstaff</td><td>${hsLine}</td></tr>` : ""}
</table>
<div style="margin-top:14px;padding-top:14px;border-top:1px solid #E5E7EB;font-size:12px;color:#6B7280">
No outbound calls placed in the last ${silentMin} minutes during this dispatcher's scheduled shift today. Cooldown ${COOLDOWN_MIN} min — at most one more alert per ${COOLDOWN_MIN} min while idle. Anchored to today's shift only. Hubstaff-break gate active — alerts hold while the dispatcher is on break.
</div>
</div>
<p style="color:#6B7280;font-size:12px;margin-top:14px;text-align:center">Local AC Reports Bot · idle alert v3</p>
</div>
</body></html>`;
}
