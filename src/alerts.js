// Live alert: when a new lead comes in via the GHL webhook, start two timers:
//   - 3 min  : 🔴 warning if no qualifying call attempt yet
//   - 10 min : 🔴🔴🔴 escalation if STILL no qualifying call attempt
//
// "Qualifying call attempt" = at least one outbound call >= 20 sec OR
// at least two outbound short calls (the dispatcher tried, hung up, tried again).
// Automated texts / SMS do NOT count — only outbound CALLs.
//
// Business-hours gate: alerts only fire for leads that arrived between
// 8:00 AM and 8:00 PM America/New_York. A lead that comes in at 1 AM is ignored
// because nobody is expected to be at the desk.
import { config } from "./config.js";
import * as ghl from "./ghl.js";
import { sendMail } from "./mailer.js";
import { renderLiveAlert } from "./template.js";
import { Alerts } from "./db.js";
import { DateTime } from "luxon";

const TZ = "America/New_York";
const BUSINESS_START_HOUR = 8;          // 8:00 AM ET inclusive
const BUSINESS_END_HOUR = 20;           // 8:00 PM ET exclusive (so last lead window is 7:59 PM)
const SHORT_CALL_THRESHOLD_SEC = 20;
const WARNING_DELAY_MS = 3 * 60 * 1000;
const ESCALATION_DELAY_MS = 10 * 60 * 1000;

// contactId -> { t3, t10 } so we can clear timers if the lead is resolved
const pendingAlerts = new Map();

function isBusinessHours(jsDate) {
  const dt = DateTime.fromJSDate(jsDate).setZone(TZ);
  return dt.hour >= BUSINESS_START_HOUR && dt.hour < BUSINESS_END_HOUR;
}

function fmtETShort(jsDate) {
  return (
    DateTime.fromJSDate(jsDate).setZone(TZ).toFormat("LLL d, h:mm a") + " ET"
  );
}

// Walk the conversation messages and pull out every OUTBOUND CALL placed
// after the lead arrived. SMS/email/etc. are ignored. Returns:
//   { calls: [{ duration, at, status }, ...], longCalls, shortCalls, attempted }
function summarizeCalls(messages, leadAddedAt) {
  const leadTime = new Date(leadAddedAt).getTime();
  const calls = [];
  for (const m of messages || []) {
    const type = String(m.type ?? "");
    const dir = String(m.direction ?? "").toLowerCase();
    // Match "CALL" and "TYPE_CALL" — GHL's enum varies between endpoints.
    if (!/CALL/i.test(type)) continue;
    if (dir !== "outbound") continue;
    const ts = new Date(m.dateAdded ?? m.createdAt ?? 0).getTime();
    if (ts < leadTime) continue;
    const duration = Number(
      m.meta?.call?.duration ?? m.callDuration ?? m.duration ?? 0
    );
    calls.push({
      duration,
      at: m.dateAdded ?? m.createdAt ?? null,
      status: m.meta?.call?.status ?? null,
    });
  }
  const longCalls = calls.filter((c) => c.duration >= SHORT_CALL_THRESHOLD_SEC);
  const shortCalls = calls.filter((c) => c.duration < SHORT_CALL_THRESHOLD_SEC);
  const attempted = longCalls.length >= 1 || shortCalls.length >= 2;
  return { calls, longCalls, shortCalls, attempted };
}

async function getCallSummary(contactId, leadAddedAt) {
  try {
    const conversations = await ghl.searchConversations({
      from: new Date(leadAddedAt).toISOString(),
      to: new Date().toISOString(),
    });
    const conv = conversations.find((c) => c.contactId === contactId);
    if (!conv) return summarizeCalls([], leadAddedAt);
    const msgs = await ghl.getConversationMessages(conv.id);
    return summarizeCalls(msgs, leadAddedAt);
  } catch (e) {
    console.error("[live-alert] GHL fetch failed", e?.message);
    return summarizeCalls([], leadAddedAt);
  }
}

async function fireAlert({ contactId, contactName, phone, leadAddedAt, level }) {
  try {
    const summary = await getCallSummary(contactId, leadAddedAt);

    // Resolved between scheduling and now? Cancel everything and bail.
    if (summary.attempted) {
      const timers = pendingAlerts.get(contactId);
      if (timers) {
        clearTimeout(timers.t3);
        clearTimeout(timers.t10);
        pendingAlerts.delete(contactId);
      }
      console.log(
        `[live-alert] suppressed (qualifying attempt) contact=${contactId} level=${level}`
      );
      return;
    }

    const elapsed = Math.round(
      (Date.now() - new Date(leadAddedAt).getTime()) / 60000
    );

    // Log to dashboard alerts table
    try {
      Alerts.log({
        contactId,
        contactName: contactName || null,
        phone: phone || null,
        leadAddedAt: leadAddedAt || null,
        minutesElapsed: elapsed,
        level,
      });
    } catch (e) {
      console.error("[live-alert] db log failed", e?.message);
    }

    // Send email
    const html = renderLiveAlert({
      leadName: contactName || "(unnamed lead)",
      phone: phone || "(no phone)",
      leadAddedAt: fmtETShort(new Date(leadAddedAt)),
      minutesElapsed: elapsed,
      level,
      callSummary: summary,
    });
    const dots = level >= 2 ? "🔴🔴🔴" : "🔴";
    const escal = level >= 2 ? "ESCALATION — " : "";
    await sendMail({
      subject: `${dots} ${escal}New lead not contacted in ${elapsed} min — ${
        contactName ?? "lead"
      }`,
      html,
    });
  } catch (e) {
    console.error("[live-alert] failed", e?.message);
  }
}

export async function onNewLead({ contactId, contactName, phone, leadAddedAt }) {
  if (!contactId) return;
  if (pendingAlerts.has(contactId)) return;

  const leadDate = new Date(leadAddedAt || Date.now());
  if (!isBusinessHours(leadDate)) {
    console.log(
      `[live-alert] lead outside business hours (8 AM–8 PM ET), skipping ${contactId} @ ${leadDate.toISOString()}`
    );
    return;
  }

  // Honour env override if someone wants to lower the warning threshold later.
  const warnMs =
    Number(config.leadResponseThresholdMinutes || 3) * 60 * 1000 ||
    WARNING_DELAY_MS;

  const t3 = setTimeout(
    () => fireAlert({ contactId, contactName, phone, leadAddedAt, level: 1 }),
    warnMs
  );
  const t10 = setTimeout(async () => {
    await fireAlert({
      contactId,
      contactName,
      phone,
      leadAddedAt,
      level: 2,
    });
    pendingAlerts.delete(contactId);
  }, ESCALATION_DELAY_MS);

  pendingAlerts.set(contactId, { t3, t10 });
}
