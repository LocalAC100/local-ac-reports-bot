// Live lead alert (v3 — per-level suppression + restart persistence).
//
// When a new lead arrives via the GHL webhook we schedule two timers:
//   - 3 min  : 🔴       warning if dispatchers haven't placed ANY outbound call yet
//   - 10 min : 🔴🔴🔴   escalation if STILL no real conversation or live transfer
//
// Per-level suppression (different rules for each timer):
//   3-min timer fires only if:
//     - 0 outbound call attempts for this contact (ANY duration)
//     - even 1 attempted dial silences it (the dispatcher tried)
//   10-min timer fires only if:
//     - 0 outbound real calls (≥ 70s) AND 0 live transfers
//     - so if they dialed 5 times but never actually talked → the 10-min STILL fires
//       (that's the escalation pattern worth catching)
//
// Both timers can fire for the same lead — they represent different failure modes.
//
// Suppression check uses the LOCAL SQLite `calls` table (populated in real time
// by the GHL call webhook). Falls back to the GHL conversation API only if the
// local table has zero rows for the contact (covers webhook misses).
//
// Business-hours gate: alerts only fire for leads that arrived 8 AM – 9 PM ET
// (matches dispatcher shifts).
//
// Persistence (v3): pending timers are mirrored to /var/data/pending-alerts.json
// so a Render restart can re-arm them via initAlerts() at boot. The in-memory
// Map remains the source of truth during a process lifetime; the JSON file is
// only consulted on cold start.

import { config } from "./config.js";
import * as ghl from "./ghl.js";
import { sendMail } from "./mailer.js";
import { renderLiveAlert } from "./template.js";
import { Alerts, Calls, classifyCall } from "./db.js";
import { DateTime } from "luxon";
import fs from "fs";
import path from "path";

const TZ = "America/New_York";
const BUSINESS_START_HOUR = 8;
const BUSINESS_END_HOUR = 21; // 9 PM ET — matches dispatcher shift end
const WARNING_DELAY_MS = 3 * 60 * 1000;
const ESCALATION_DELAY_MS = 10 * 60 * 1000;
const ALERT_RECIPIENT = "service@local-ac.com";

// contactId -> { t3, t10, contactName, phone, leadAddedAt, level1FireAt, level2FireAt }
const pendingAlerts = new Map();

// ---------- Disk persistence (best-effort) ----------

function pickPersistPath() {
  const candidates = [
    process.env.DATA_DIR
      ? path.join(process.env.DATA_DIR, "pending-alerts.json")
      : null,
    process.env.RENDER ? "/var/data/pending-alerts.json" : null,
    path.resolve("./data/pending-alerts.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.accessSync(path.dirname(p), fs.constants.W_OK);
      return p;
    } catch {}
  }
  return null;
}
const PERSIST_PATH = pickPersistPath();

function persistPending() {
  if (!PERSIST_PATH) return;
  try {
    const snapshot = [];
    for (const [contactId, v] of pendingAlerts.entries()) {
      snapshot.push({
        contactId,
        contactName: v.contactName ?? null,
        phone: v.phone ?? null,
        leadAddedAt: v.leadAddedAt ?? null,
        level1FireAt: v.level1FireAt ?? null,
        level2FireAt: v.level2FireAt ?? null,
      });
    }
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(snapshot, null, 2), "utf8");
  } catch (e) {
    console.warn("[live-alert] persist failed:", e?.message);
  }
}

function loadPersisted() {
  if (!PERSIST_PATH) return [];
  try {
    if (!fs.existsSync(PERSIST_PATH)) return [];
    return JSON.parse(fs.readFileSync(PERSIST_PATH, "utf8"));
  } catch (e) {
    console.warn("[live-alert] load failed:", e?.message);
    return [];
  }
}

// ---------- Helpers ----------

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

  return {
    realCalls,
    liveTransfers,
    totalAttempts,
    longCalls: calls.filter((c) => (c.duration || 0) >= 70),
    shortCalls: calls.filter((c) => (c.duration || 0) < 70),
    calls,
    // Back-compat: any qualifying activity at all (callers used this before v3).
    attempted: totalAttempts >= 1,
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

  return {
    realCalls,
    liveTransfers,
    totalAttempts,
    longCalls: calls.filter((c) => (c.duration || 0) >= 70),
    shortCalls: calls.filter((c) => (c.duration || 0) < 70),
    calls,
    attempted: totalAttempts >= 1,
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

// ---------- Per-level suppression deciders ----------

// 3-min: any outbound attempt silences the alert.
function isSuppressedForLevel1(summary) {
  return (summary.totalAttempts || 0) >= 1;
}

// 10-min: only a real conversation (≥70s) or a live transfer silences the alert.
// Just attempts ≥1 are NOT enough — that's the escalation we want to catch.
function isSuppressedForLevel2(summary) {
  return (summary.realCalls || 0) >= 1 || (summary.liveTransfers || 0) >= 1;
}

// ---------- Alert firing ----------

async function fireAlert({ contactId, contactName, phone, leadAddedAt, level }) {
  try {
    const summary = await getCallSummary(contactId, leadAddedAt);

    const suppressed =
      level >= 2 ? isSuppressedForLevel2(summary) : isSuppressedForLevel1(summary);

    if (suppressed) {
      // Only clear timers when the LEVEL-2 escalation is suppressed — the
      // 3-min and 10-min checks are independent escalations, so suppressing
      // the 3-min should NOT short-circuit the 10-min still firing if no real
      // conversation happens.
      if (level >= 2) {
        const timers = pendingAlerts.get(contactId);
        if (timers) {
          clearTimeout(timers.t3);
          clearTimeout(timers.t10);
          pendingAlerts.delete(contactId);
          persistPending();
        }
      }
      console.log(
        `[live-alert] suppressed level=${level} (${summary._source}) contact=${contactId} real=${summary.realCalls} lt=${summary.liveTransfers} att=${summary.totalAttempts}`
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
      to: ALERT_RECIPIENT,
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
      `[live-alert] outside business hours (8 AM–9 PM ET), skipping ${contactId} @ ${leadDate.toISOString()}`
    );
    return;
  }

  const warnMs =
    Number(config.leadResponseThresholdMinutes || 3) * 60 * 1000 ||
    WARNING_DELAY_MS;
  const escalMs = ESCALATION_DELAY_MS;

  const now = Date.now();
  schedulePair({
    contactId,
    contactName,
    phone,
    leadAddedAt,
    level1FireAt: now + warnMs,
    level2FireAt: now + escalMs,
  });
}

function schedulePair({ contactId, contactName, phone, leadAddedAt, level1FireAt, level2FireAt }) {
  const now = Date.now();
  const t3Delay = Math.max(0, level1FireAt - now);
  const t10Delay = Math.max(0, level2FireAt - now);

  const t3 =
    level1FireAt > now
      ? setTimeout(
          () => fireAlert({ contactId, contactName, phone, leadAddedAt, level: 1 }),
          t3Delay
        )
      : null;
  const t10 =
    level2FireAt > now
      ? setTimeout(async () => {
          await fireAlert({ contactId, contactName, phone, leadAddedAt, level: 2 });
          pendingAlerts.delete(contactId);
          persistPending();
        }, t10Delay)
      : null;

  pendingAlerts.set(contactId, {
    t3,
    t10,
    contactName,
    phone,
    leadAddedAt,
    level1FireAt,
    level2FireAt,
  });
  persistPending();
  console.log(
    `[live-alert] scheduled contact=${contactId} (level1 in ${Math.round(
      t3Delay / 1000
    )}s, level2 in ${Math.round(t10Delay / 1000)}s)`
  );
}

// Re-arm any persisted pending alerts whose timers haven't elapsed yet.
// Called once at boot from index.js. Safe to call multiple times — it skips
// contacts already in the in-memory Map.
export function initAlerts() {
  const persisted = loadPersisted();
  const now = Date.now();
  let rearmed = 0;
  let dropped = 0;
  for (const a of persisted) {
    if (!a?.contactId) continue;
    if (pendingAlerts.has(a.contactId)) continue;
    const l1 = Number(a.level1FireAt) || 0;
    const l2 = Number(a.level2FireAt) || 0;
    if (l1 <= now && l2 <= now) {
      dropped++;
      continue;
    }
    schedulePair({
      contactId: a.contactId,
      contactName: a.contactName,
      phone: a.phone,
      leadAddedAt: a.leadAddedAt,
      level1FireAt: l1,
      level2FireAt: l2,
    });
    rearmed++;
  }
  console.log(
    `[live-alert] initAlerts: rearmed=${rearmed} dropped_expired=${dropped} persistPath=${
      PERSIST_PATH || "(none)"
    }`
  );
  return { rearmed, dropped };
}
