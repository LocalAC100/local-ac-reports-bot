// Real-time dispatcher-idle alert (v2 — anchored to today's shift, local-first).
//
// Every 5 min during business hours, scan on-shift dispatchers. Fire an alert
// for anyone who hasn't placed an OUTBOUND CALL in 20+ minutes during their
// scheduled shift today.
//
// Anchored to TODAY's shift only — `idle = now − max(last_call_today_in_shift,
// shift_start_today)`. Eliminates the "1,211-min idle" false alerts caused by
// the old logic that compared to an arbitrary global "last activity".
//
// Source: local SQLite `calls` table (populated in real time by the GHL
// webhook). No GHL conversation API calls — those were slow and stale.
//
// 30-min cooldown per dispatcher so the same person doesn't get re-alerted
// every 5 min while still idle.

import { DateTime } from "luxon";
import * as ghl from "./ghl.js";
import { EMPLOYEES, isDispatcher, expectedShiftFor } from "./employees.js";
import { sendMail } from "./mailer.js";
import { Alerts, Calls } from "./db.js";

const TZ = "America/New_York";
const IDLE_THRESHOLD_MIN = 20; // default — overridable via emp.idleThresholdMin
const COOLDOWN_MIN = 30;

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

export async function checkIdleDispatchers() {
  const now = DateTime.now().setZone(TZ);

  // Find on-shift dispatchers
  const onShift = [];
  for (const e of EMPLOYEES) {
    if (!isDispatcher(e)) continue;
    if (!e.ghlEmail) continue;
    const win = shiftWindowToday(e, now);
    if (!win) continue;
    if (now < win.start || now >= win.end) continue;
    onShift.push({ emp: e, ...win });
  }

  if (!onShift.length) {
    console.log(`[idle] no dispatchers on shift @ ${now.toFormat("h:mm a")}`);
    return;
  }

  // GHL email → user_id map (so we can filter the calls table by this dispatcher).
  let ghlUsers = [];
  try {
    ghlUsers = await ghl.listUsers();
  } catch (e) {
    console.error("[idle] listUsers failed:", e?.message);
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
    const userId = userIdByEmail.get((emp.ghlEmail || "").toLowerCase());
    if (!userId) {
      console.log(
        `[idle] ${emp.name} — no GHL user_id mapping for ${emp.ghlEmail}, skipping`
      );
      continue;
    }

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

    const lastAlertAt = state.get(emp.name)?.lastAlertAt;
    const inCooldown =
      lastAlertAt && now.diff(lastAlertAt, "minutes").minutes < COOLDOWN_MIN;

    const threshold = thresholdFor(emp);

    if (idleMin >= threshold && !inCooldown) {
      const html = renderIdleAlertHtml({
        dispatcher: emp.name,
        silentMin: idleMin,
        lastEventAt,
        shiftStart: shift.start,
      });
      try {
        await sendMail({
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
      }
      state.set(emp.name, { lastEventAt, lastAlertAt: now });
    } else {
      state.set(emp.name, { lastEventAt, lastAlertAt });
      if (lastEventAt) {
        console.log(
          `[idle] ${emp.name} OK (silent ${idleMin}m, last ${lastEventAt.toFormat(
            "h:mm a"
          )})`
        );
      } else {
        console.log(
          `[idle] ${emp.name} OK (no calls yet, ${idleMin}m since shift start)`
        );
      }
    }
  }
}

function renderIdleAlertHtml({ dispatcher, silentMin, lastEventAt, shiftStart }) {
  const lastStr = lastEventAt
    ? lastEventAt.toFormat("h:mm a") + " ET"
    : "(no outbound calls since shift started)";
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
</table>
<div style="margin-top:14px;padding-top:14px;border-top:1px solid #E5E7EB;font-size:12px;color:#6B7280">
No outbound calls placed in the last ${silentMin} minutes during this dispatcher's scheduled shift today. Cooldown ${COOLDOWN_MIN} min — at most one more alert per ${COOLDOWN_MIN} min while idle. Anchored to today's shift only.
</div>
</div>
<p style="color:#6B7280;font-size:12px;margin-top:14px;text-align:center">Local AC Reports Bot · idle alert v2</p>
</div>
</body></html>`;
}
