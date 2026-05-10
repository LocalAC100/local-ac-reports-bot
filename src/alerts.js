// Live lead alert (v2 — local-first suppression).
//
// When a new lead arrives via the GHL webhook we schedule two timers:
//   - 3 min  : 🔴       warning if the dispatchers haven't made a qualifying attempt
//   - 10 min : 🔴🔴🔴   escalation if STILL no qualifying attempt
//
// Suppression rules (any of these silences the alert):
//   - 1+ outbound real call (≥ 70s)        — they had a real conversation
//   - 1+ live transfer                     — they got transferred to sales
//   - 2+ outbound call attempts (any dur)  — they tried hard
//
// Texts / SMS do NOT suppress. A text means the call wasn't answered.
//
// Suppression check uses the LOCAL SQLite `calls` table (populated in real time
// by the GHL call webhook). Falls back to the GHL conversation API only if the
// local table has zero rows for the contact (covers webhook misses).
//
// Business-hours gate: alerts only fire for leads that arrived 8 AM – 8 PM ET.

import { config } from "./config.js";
import * as ghl from "./ghl.js";
import { sendMail } from "./mailer.js";
import { renderLiveAlert } from "./template.js";
import { Alerts, Calls, classifyCall } from "./db.js";
import { DateTime } from "luxon";

const TZ = "America/New_York";
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 20;
const WARNING_DELAY_MS = 3 * 60 * 1000;
const ESCALATION_DELAY_MS = 10 * 60 * 1000;

// contactId -> { t3, t10 } so we can clear timers if the lead resolves before the timer fires.
const pendingAlerts = new Map();

function isBusinessHours(jsDate) {
  const dt = DateTime.fromJSDate(jsDate).setZone(TZ);
  return dt.hour >= BUSINESS_START_HOUR && dt.hour < BUSINESS_END_HOUR;
}

function fmtETShort(jsDate) {
  return DateTime.fromJSDate(jsDate).setZone(TZ).toFormat("LLL d, h:mm a") + " ET";
}

// ---------- Suppression — primary source: local SQLite calls table ----------

function checkSuppressionLocal(contactId, leadAddedAt) {
  const fromIso = new Date(leadAddedAt).toISOString();
  const toIso = new Date().toISOString();
  const allRows = Calls.listInWindow(fromIso, toIso, 5000);

  // Outbound only, this contact only.
  const rows = allRows.filter(
    (r) =>
      r.contact_id === contactId &&
      (r.direction || "").toLowerCase() === "outbound"
  );

  let realCalls = 0;
  let liveTransfers = 0;
  const calls = [];
  for (const r of rows) {
    let raw = {};
    try { if (r.raw_event) raw = JSON.parse(r.raw_event); } catch {}
    const bucket = classifyCall({
      status: r.status,
      duration: r.duration,
      participants: raw.participants,
    });
    if (bucket === "real_call") realCalls++;
    if (bucket === "live_transfer") liveTransfers++;
    calls.push({
      duration: r.duration || 0,
      at: r.date_added,
      status: r.status,
    });
  }

  const totalAttempts = rows.length;
  const suppress = realCalls >= 1 || liveTransfers >= 1 || totalAttempts >= 2;

  return {
    realCalls,
    liveTransfers,
    totalAttempts,
    longCalls: calls.filter((c) => (c.duration || 0) >= 70),
    shortCalls: calls.filter((c) => (c.duration || 0) < 70),
    calls,
    attempted: suppress,
    _source: "local",
    _diag: { sourceTable: "calls", rowCount: rows.length },
  };
}

// ---------- Suppression — fallback: GHL conversation API ----------

async function checkSuppressionGHL(contactId, leadAddedAt) {
  const leadTime = new Date(leadAddedAt).getTime();
  const conversations = await ghl
    .getConversationsByContactId(contactId)
    .catch(() => []);

  const allMessages = [];
  for (const conv of conversations) {
    const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
    for (const m of msgs) allMessages.push(m);
  }

  let realCalls = 0;
  let liveTransfers = 0;
  let totalAttempts = 0;
  const calls = [];
  for (const m of allMessages) {
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
    totalAttempts++;
    if (duration >= 70) {
      const participants = m.meta?.call?.participants || {};
      const hasTransfer = Object.values(participants).some(
        (p) => typeof p?.label === "string" && p.label.startsWith("transfer:")
      );
      if (hasTransfer) liveTransfers++;
      else realCalls++;
    }
    calls.push({
      duration,
      at: m.dateAdded ?? m.createdAt ?? null,
      status: m.meta?.call?.status ?? null,
    });
  }

  // Vonage notes — "Called …" notes count as outbound attempts.
  const notes = await ghl.getContactNotes(contactId).catch(() => []);
  const vonageCallsAfterLead = (notes || []).filter((n) => {
    if (!/^\s*called\b/i.test(String(n?.body || ""))) return false;
    const ts = new Date(n.dateAdded || 0).getTime();
    return ts >= leadTime;
  }).length;
  totalAttempts += vonageCallsAfterLead;

  const suppress = realCalls >= 1 || liveTransfers >= 1 || totalAttempts >= 2;

  return {
    realCalls,
    liveTransfers,
    totalAttempts,
    longCalls: calls.filter((c) => (c.duration || 0) >= 70),
    shortCalls: calls.filter((c) => (c.duration || 0) < 70),
    calls,
    attempted: suppress,
    vonageCalls: vonageCallsAfterLead,
    _source: "ghl",
    _diag: {
      sourceTable: "ghl-conversations",
      conversationCount: conversations.length,
      messageCount: allMessages.length,
      noteCount: notes?.length || 0,
    },
  };
}

// Try local first; only hit GHL if the local table has nothing for this contact.
async function getCallSummary(contactId, leadAddedAt) {
  const local = checkSuppressionLocal(contactId, leadAddedAt);
  if (local.totalAttempts > 0) return local;
  return await checkSuppressionGHL(contactId, leadAddedAt);
}

// Exported for the debug endpoint.
export const _internal = { getCallSummary, checkSuppressionLocal, checkSuppressionGHL };

// ---------- Alert firing ----------

async function fireAlert({ contactId, contactName, phone, leadAddedAt, level }) {
  try {
    const summary = await getCallSummary(contactId, leadAddedAt);

    if (summary.attempted) {
      const timers = pendingAlerts.get(contactId);
      if (timers) {
        clearTimeout(timers.t3);
        clearTimeout(timers.t10);
        pendingAlerts.delete(contactId);
      }
      console.log(
        `[live-alert] suppressed (${summary._source}) contact=${contactId} level=${level} real=${summary.realCalls} lt=${summary.liveTransfers} att=${summary.totalAttempts}`
      );
      return;
    }

    const elapsed = Math.round(
      (Date.now() - new Date(leadAddedAt).getTime()) / 60000
    );

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

    console.log(
      `[live-alert] FIRED level=${level} contact=${contactId} elapsed=${elapsed}m source=${summary._source}`
    );
  } catch (e) {
    console.error("[live-alert] failed", e?.message);
  }
}

// ---------- Public entry point ----------

export async function onNewLead({ contactId, contactName, phone, leadAddedAt }) {
  if (!contactId) return;
  if (pendingAlerts.has(contactId)) return;

  const leadDate = new Date(leadAddedAt || Date.now());
  if (!isBusinessHours(leadDate)) {
    console.log(
      `[live-alert] outside business hours (8 AM–8 PM ET), skipping ${contactId} @ ${leadDate.toISOString()}`
    );
    return;
  }

  const warnMs =
    Number(config.leadResponseThresholdMinutes || 3) * 60 * 1000 ||
    WARNING_DELAY_MS;

  const t3 = setTimeout(
    () => fireAlert({ contactId, contactName, phone, leadAddedAt, level: 1 }),
    warnMs
  );
  const t10 = setTimeout(async () => {
    await fireAlert({ contactId, contactName, phone, leadAddedAt, level: 2 });
    pendingAlerts.delete(contactId);
  }, ESCALATION_DELAY_MS);

  pendingAlerts.set(contactId, { t3, t10 });
  console.log(`[live-alert] scheduled contact=${contactId} (3min + 10min)`);
}
