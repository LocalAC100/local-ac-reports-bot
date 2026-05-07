// Real-time idle-alert: every 5 minutes, scan on-shift dispatchers and fire
// an alert for anyone who has been silent (no GHL outbound calls, Vonage
// "Called" notes, or outbound SMS) for 20+ minutes. Process-local state +
// 60-min cooldown per dispatcher so the same person doesn't get re-alerted
// every 5 minutes if they stay idle.
//
// Cron (added in index.js): every 5 min from 8 AM to 8 PM ET.
import { DateTime } from "luxon";
import * as ghl from "./ghl.js";
import { EMPLOYEES, isDispatcher, expectedShiftFor } from "./employees.js";
import { sendMail } from "./mailer.js";
import { Alerts } from "./db.js";

const TZ = "America/New_York";
const IDLE_THRESHOLD_MIN = 20;
const COOLDOWN_MIN = 60;
const LOOKBACK_MIN = 30; // window of GHL conversations to scan

// Per-dispatcher: { lastEventAt: DateTime, lastAlertAt: DateTime }
const state = new Map();

function isOnShift(emp, dt) {
  const shift = expectedShiftFor(emp, dt);
  if (!shift) return null;
  const [sh, sm] = shift.start.split(":").map(Number);
  const [eh, em] = shift.end.split(":").map(Number);
  const start = dt.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
  const end = dt.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  if (dt < start || dt > end) return null;
  return { shift, start, end };
}

export async function checkIdleDispatchers() {
  const nowDt = DateTime.now().setZone(TZ);

  // Find on-shift dispatchers
  const onShift = [];
  for (const e of EMPLOYEES) {
    if (!isDispatcher(e)) continue;
    if (!e.ghlEmail) continue;
    const s = isOnShift(e, nowDt);
    if (!s) continue;
    onShift.push({ emp: e, shift: s });
  }
  if (!onShift.length) {
    console.log(`[idle] no dispatchers on shift @ ${nowDt.toFormat("h:mm a")}`);
    return;
  }

  // Map GHL email → user
  const ghlUsers = await ghl.listUsers().catch(() => []);
  const ghlByEmail = new Map(
    ghlUsers.map((u) => [(u.email || "").toLowerCase(), u])
  );

  // Pull recent conversations to scan for events
  const lookbackStart = nowDt.minus({ minutes: LOOKBACK_MIN });
  const conversations = await ghl
    .listActiveConversations({
      from: lookbackStart.toUTC().toISO(),
      to: nowDt.toUTC().toISO(),
    })
    .catch(() => []);

  // Pre-fetch messages once to keep API calls bounded
  const convMessages = new Map();
  for (const conv of conversations) {
    const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
    convMessages.set(conv.id, msgs);
  }

  for (const { emp, shift } of onShift) {
    const ghlUser = ghlByEmail.get((emp.ghlEmail || "").toLowerCase());
    if (!ghlUser) continue;
    const userId = ghlUser.id;

    let lastEventAt = state.get(emp.name)?.lastEventAt || null;

    // Walk recent messages — count ANY outbound activity from this dispatcher
    // as evidence they're working. Includes:
    //   - calls (type=1 / TYPE_CALL)
    //   - SMS (type=2 / TYPE_SMS)
    //   - emails (TYPE_EMAIL)
    //   - INTERNAL_COMMENT (where dispatchers log Vonage calls)
    //   - any other outbound action
    // The point is: if the dispatcher took ANY action on this contact, they're
    // not idle. We don't need to be picky about message type — we already
    // filter by userId and direction=outbound, which is enough.
    for (const conv of conversations) {
      for (const m of convMessages.get(conv.id) || []) {
        if (m.userId !== userId) continue;
        if (String(m.direction || "").toLowerCase() !== "outbound") continue;
        // Skip system-generated workflow events (no user attribution implies bot)
        // — but we already check userId === this dispatcher above, so any match
        // is a real user action.
        const dt = DateTime.fromISO(m.dateAdded || m.createdAt || "").setZone(TZ);
        if (!dt.isValid) continue;
        if (!lastEventAt || dt > lastEventAt) lastEventAt = dt;
      }
      // Also check contact notes (some dispatchers add Vonage notes there
      // instead of as conversation comments). Same "Called" prefix detector.
      if (conv.contactId) {
        const notes = await ghl.getContactNotes(conv.contactId).catch(() => []);
        for (const n of notes) {
          if (n.userId !== userId) continue;
          if (!/^\s*called\b/i.test(String(n.body || ""))) continue;
          const dt = DateTime.fromISO(n.dateAdded || "").setZone(TZ);
          if (!dt.isValid) continue;
          if (!lastEventAt || dt > lastEventAt) lastEventAt = dt;
        }
      }
    }

    // If we have no events and the shift just started, give a 20-min grace before flagging
    const sinceShiftStartMin = nowDt.diff(shift.start, "minutes").minutes;
    const silentMin = lastEventAt
      ? Math.round(nowDt.diff(lastEventAt, "minutes").minutes)
      : Math.round(sinceShiftStartMin);

    const lastAlertAt = state.get(emp.name)?.lastAlertAt;
    const inCooldown =
      lastAlertAt && nowDt.diff(lastAlertAt, "minutes").minutes < COOLDOWN_MIN;

    if (silentMin >= IDLE_THRESHOLD_MIN && !inCooldown) {
      const html = renderIdleAlertHtml({
        dispatcher: emp.name,
        silentMin,
        lastEventAt,
        shiftStart: shift.shift.start,
      });
      try {
        await sendMail({
          subject: `🔴 ${emp.name} idle for ${silentMin} min — no calls, texts, or notes`,
          html,
        });
        Alerts.log({
          contactId: `idle-${emp.name}-${nowDt.toMillis()}`,
          contactName: `(idle: ${emp.name})`,
          phone: null,
          leadAddedAt: nowDt.toISO(),
          minutesElapsed: silentMin,
          level: 1,
        });
        console.log(
          `[idle] FIRED for ${emp.name} silent ${silentMin}m (last event ${
            lastEventAt ? lastEventAt.toFormat("h:mm a") : "never"
          })`
        );
      } catch (err) {
        console.error("[idle] send failed", err?.message);
      }
      state.set(emp.name, { lastEventAt, lastAlertAt: nowDt });
    } else {
      state.set(emp.name, { lastEventAt, lastAlertAt });
      if (lastEventAt) {
        console.log(
          `[idle] ${emp.name} OK (silent ${silentMin}m, last ${lastEventAt.toFormat(
            "h:mm a"
          )})`
        );
      }
    }
  }
}

function renderIdleAlertHtml({ dispatcher, silentMin, lastEventAt, shiftStart }) {
  const lastStr = lastEventAt
    ? lastEventAt.toFormat("h:mm a") + " ET"
    : "(no activity since shift started)";
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
        <tr><td style="color:#6B7280">Last GHL event</td><td>${lastStr}</td></tr>
        <tr><td style="color:#6B7280">Silent for</td><td><strong style="color:#DC2626">${silentMin} minutes</strong></td></tr>
        <tr><td style="color:#6B7280">Shift starts</td><td>${shiftStart}</td></tr>
      </table>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid #E5E7EB;font-size:12px;color:#6B7280">
        No outbound calls, Vonage "Called" notes, or outbound texts in the last ${silentMin} minutes during this dispatcher's scheduled shift. Cooldown ${COOLDOWN_MIN} min — they'll get one more alert at most per hour while idle.
      </div>
    </div>
    <p style="color:#6B7280;font-size:12px;margin-top:14px;text-align:center">Local AC Reports Bot · idle alert · <a href="https://controlroom.local-ac.com/alerts" style="color:#0891B2">view all alerts</a></p>
  </div>
</body></html>`;
}
