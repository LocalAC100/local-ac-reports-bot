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
    // GHL returns calls with type=1 (numeric) AND messageType="TYPE_CALL" (string).
    // Some endpoints/payloads may also return the bare string "CALL".
    // We match on ALL THREE forms because none alone is reliable —
    // earlier we missed every call because we only checked /CALL/i against
    // a stringified numeric type.
    const isCall =
      m.type === 1 ||
      m.messageType === "TYPE_CALL" ||
      /CALL/i.test(String(m.type ?? ""));
    if (!isCall) continue;
    const dir = String(m.direction ?? "").toLowerCase();
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

// Vonage call note detector. Dispatchers add a GHL note starting with "Called"
// any time they call via Vonage (which has no API on regular accounts).
// We treat any such note from any user as a qualifying contact attempt.
function isVonageCallNote(note) {
  return /^\s*called\b/i.test(String(note?.body || ""));
}

// Walk every outbound non-call message (SMS, email, etc.) made by anyone
// AFTER the lead arrived. Used as a SECONDARY signal — if a dispatcher
// reached out via text instead of calling, that's still contact, suppress alert.
function hasOutboundContactAfterLead(messages, leadAddedAt) {
  const leadTime = new Date(leadAddedAt).getTime();
  for (const m of messages || []) {
    const dir = String(m.direction ?? "").toLowerCase();
    if (dir !== "outbound") continue;
    const ts = new Date(m.dateAdded ?? m.createdAt ?? 0).getTime();
    if (ts < leadTime) continue;
    return true; // any outbound activity counts as contact
  }
  return false;
}

async function getCallSummary(contactId, leadAddedAt) {
  try {
    const leadTime = new Date(leadAddedAt).getTime();

    // FIX (May 7 2026): use getConversationsByContactId — direct lookup by
    // contactId. Previously used searchConversations({from,to}) which filters
    // by conversation CREATION date and missed any contact whose conversation
    // existed before the webhook fired (very common). That bug caused multiple
    // false-positive alerts (Tinnelly, Juan Lopez, mike +13157976111).
    const [conversations, notes] = await Promise.all([
      ghl.getConversationsByContactId(contactId).catch(() => []),
      ghl.getContactNotes(contactId).catch(() => []),
    ]);

    // Pull messages from EVERY conversation for this contact and merge them.
    // Most contacts have one, but some have multiple (e.g., one for SMS, one
    // for calls). Don't lose calls by only checking the first conversation.
    const allMessages = [];
    for (const conv of conversations) {
      const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
      for (const m of msgs) allMessages.push(m);
    }
    const summary = summarizeCalls(allMessages, leadAddedAt);

    // Fold Vonage notes in — any "Called" note added AFTER the lead arrived
    // counts as a qualifying attempt (so we don't false-fire when dispatcher
    // calls only via Vonage).
    const vonageCallsAfterLead = (notes || []).filter((n) => {
      if (!isVonageCallNote(n)) return false;
      const ts = new Date(n.dateAdded || 0).getTime();
      return ts >= leadTime;
    }).length;

    if (vonageCallsAfterLead > 0) {
      summary.attempted = true;
      summary.vonageCalls = vonageCallsAfterLead;
    }

    // ALSO suppress if the dispatcher reached out via text/SMS — that's still
    // contact even if no phone call was placed. Lots of dispatchers respond to
    // brand-new leads with a quick text first.
    const hadOutboundContact = hasOutboundContactAfterLead(allMessages, leadAddedAt);
    if (hadOutboundContact) {
      summary.attempted = true;
      summary.outboundContact = true;
    }

    // Track totals for debugging output
    summary._diag = {
      conversationCount: conversations.length,
      messageCount: allMessages.length,
      noteCount: notes?.length || 0,
    };

    return summary;
  } catch (e) {
    console.error("[live-alert] GHL fetch failed", e?.message);
    return summarizeCalls([], leadAddedAt);
  }
}

// Exported so the debug endpoint can inspect what alerts.js sees for a contact.
export const _internal = { getCallSummary };

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
