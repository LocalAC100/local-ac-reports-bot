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

  // All calls for this contact in window — INBOUND and OUTBOUND both count for
  // the "real call" / "live transfer" determination (Joel case: customer
  // called us, the conversation lasted >70s — that's real contact regardless
  // of who dialed). Only OUTBOUND counts toward outboundAttempts (used by the
  // 10-min escalation rule).
  const rows = allRows.filter((r) => r.contact_id === contactId);

  let outboundAttempts = 0;
  let realCalls = 0;
  let liveTransfers = 0;
  const calls = [];
  for (const r of rows) {
    const dir = (r.direction || "").toLowerCase();
    let raw = {};
    try { if (r.raw_event) raw = JSON.parse(r.raw_event); } catch {}
    const bucket = classifyCall({
      status: r.status,
      duration: r.duration,
      participants: raw.participants,
    });
    if (dir === "outbound") outboundAttempts++;
    if (bucket === "real_call") realCalls++;
    if (bucket === "live_transfer") liveTransfers++;
    calls.push({
      duration: r.duration || 0,
      direction: dir,
      at: r.date_added,
      status: r.status,
      bucket,
    });
  }

  return {
    outboundAttempts,
    realCalls,
    liveTransfers,
    // Back-compat alias used by older debug paths (counts outbound only).
    totalAttempts: outboundAttempts,
    longCalls: calls.filter((c) => (c.duration || 0) >= 70),
    shortCalls: calls.filter((c) => (c.duration || 0) < 70),
    calls,
    attempted: outboundAttempts >= 1 || realCalls >= 1 || liveTransfers >= 1,
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

  let outboundAttempts = 0;
  let realCalls = 0;
  let liveTransfers = 0;
  const calls = [];
  for (const m of allMessages) {
    const isCall =
      m.type === 1 ||
      m.messageType === "TYPE_CALL" ||
      /CALL/i.test(String(m.type ?? ""));
    if (!isCall) continue;
    const dir = String(m.direction ?? "").toLowerCase();
    const ts = new Date(m.dateAdded ?? m.createdAt ?? 0).getTime();
    if (ts < leadTime) continue;
    const duration = Number(
      m.meta?.call?.duration ?? m.callDuration ?? m.duration ?? 0
    );
    if (dir === "outbound") outboundAttempts++;
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
      direction: dir,
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
  outboundAttempts += vonageCallsAfterLead;

  return {
    outboundAttempts,
    realCalls,
    liveTransfers,
    totalAttempts: outboundAttempts,
    longCalls: calls.filter((c) => (c.duration || 0) >= 70),
    shortCalls: calls.filter((c) => (c.duration || 0) < 70),
    calls,
    attempted: outboundAttempts >= 1 || realCalls >= 1 || liveTransfers >= 1,
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
//
// "outboundAttempts" = any outbound dial (any duration) for this contact.
// "realCalls"        = any call (INBOUND or outbound) with duration ≥70s and
//                       not a live transfer. Inbound counts because if the
//                       customer calls us back and we talk for 70+ seconds,
//                       that's real contact regardless of who dialed first
//                       (Joel case).
// "liveTransfers"    = any call (either direction) that ended in a transfer
//                       label like "transfer:sales".

// 3-min: silenced by ANY contact at all.
function isSuppressedForLevel1(summary) {
  return (
    (summary.outboundAttempts || summary.totalAttempts || 0) >= 1 ||
    (summary.realCalls || 0) >= 1 ||
    (summary.liveTransfers || 0) >= 1
  );
}

// 10-min: silenced by EITHER a genuine conversation/transfer, OR 2+ outbound
// dials. So Robert (dispatchers called him twice within 10 min without
// reaching him) doesn't get escalated. Escalation fires only when dispatchers
// essentially gave up — 0 or 1 attempt, no real conversation, no transfer.
function isSuppressedForLevel2(summary) {
  return (
    (summary.outboundAttempts || summary.totalAttempts || 0) >= 2 ||
    (summary.realCalls || 0) >= 1 ||
    (summary.liveTransfers || 0) >= 1
  );
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
        `[live-alert] suppressed level=${level} (${summary._source}) contact=${contactId} real=${summary.realCalls} lt=${summary.liveTransfers} outAtt=${summary.outboundAttempts ?? summary.totalAttempts}`
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
    // Overnight leads do NOT schedule the 3-min / 10-min timers — the
    // dispatchers aren't on shift to receive the call. Instead, the
    // morning catch-up cron at 8:15 AM ET scans all overnight leads and
    // fires a single summary alert for any that still haven't been
    // contacted by then.
    console.log(
      `[live-alert] overnight lead (outside 8 AM–9 PM ET), skipping live timers, will be checked at 8:15 AM by morning catch-up: ${contactId} @ ${leadDate.toISOString()}`
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

// =====================================================================
// Morning catch-up — fires once a day at 8:15 AM ET. Scans every lead that
// arrived overnight (9 PM previous day through 8 AM today) and emits a
// single summary alert listing any that still haven't been contacted by
// dispatchers. Overnight leads do NOT get the live 3-min / 10-min timers,
// so this is their only alert path.
//
// "Contacted" = same suppression rule used for live alerts:
//   - 1+ outbound dial attempt (any duration), OR
//   - 1+ real call ≥70s (inbound or outbound), OR
//   - 1+ live transfer
//
// One email per morning. No escalation — the dispatchers see this at the
// start of the shift and the response time rolls into the regular daily
// metrics from that point on.
// =====================================================================
export async function runMorningCatchUp(opts = {}) {
  const dryRun = !!opts.dryRun;
  const now = DateTime.now().setZone(TZ);
  // Window: yesterday 9 PM ET → today 8 AM ET.
  const todayShiftStart = now.set({
    hour: BUSINESS_START_HOUR,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const overnightStart = todayShiftStart.minus({ hours: 11 }); // 11h before 8 AM = 9 PM previous day
  const fromIso = overnightStart.toUTC().toISO();
  const toIso = todayShiftStart.toUTC().toISO();
  const fromMs = overnightStart.toMillis();
  const toMs = todayShiftStart.toMillis();

  console.log(
    `[morning-catchup] window=${overnightStart.toISO()} → ${todayShiftStart.toISO()} (9 PM ET prev → 8 AM ET today)`
  );

  let contacts = [];
  try {
    contacts = await ghl.searchContacts({
      from: fromIso,
      to: toIso,
      limit: 500,
    });
  } catch (e) {
    console.error("[morning-catchup] searchContacts failed:", e?.message);
    return { ok: false, error: e?.message };
  }

  const inWindow = [];
  for (const c of contacts || []) {
    if (!c?.id || !c.dateAdded) continue;
    const t = new Date(c.dateAdded).getTime();
    if (t < fromMs || t > toMs) continue;
    inWindow.push(c);
  }

  const uncontacted = [];
  for (const c of inWindow) {
    let summary;
    try {
      summary = await getCallSummary(c.id, c.dateAdded);
    } catch (e) {
      console.error(
        `[morning-catchup] getCallSummary failed for ${c.id}:`,
        e?.message
      );
      // Treat fetch failure as "unknown" — better to alert than miss.
      summary = { outboundAttempts: 0, realCalls: 0, liveTransfers: 0 };
    }
    const contacted =
      (summary.outboundAttempts || summary.totalAttempts || 0) >= 1 ||
      (summary.realCalls || 0) >= 1 ||
      (summary.liveTransfers || 0) >= 1;
    if (contacted) continue;

    const t = new Date(c.dateAdded).getTime();
    uncontacted.push({
      contactId: c.id,
      name:
        `${c.firstName || ""} ${c.lastName || ""}`.trim() ||
        c.contactName ||
        "(unnamed)",
      phone: c.phone || "(no phone)",
      source: c.source || "(no source)",
      addedAt: c.dateAdded,
      addedAtFmt: fmtETShort(new Date(c.dateAdded)),
      ageMinutes: Math.round((Date.now() - t) / 60000),
    });
  }

  const result = {
    ok: true,
    dryRun,
    windowFrom: overnightStart.toISO(),
    windowTo: todayShiftStart.toISO(),
    overnightContactCount: inWindow.length,
    uncontactedCount: uncontacted.length,
    uncontacted,
  };

  if (!uncontacted.length) {
    console.log(
      `[morning-catchup] all ${inWindow.length} overnight leads contacted, no alert`
    );
    return result;
  }

  if (dryRun) {
    console.log(
      `[morning-catchup] DRY-RUN would fire for ${uncontacted.length} uncontacted leads (of ${inWindow.length} overnight)`
    );
    return result;
  }

  const html = renderMorningCatchUpHtml({
    uncontacted,
    overnightTotal: inWindow.length,
    windowFromFmt: overnightStart.toFormat("LLL d, h:mm a") + " ET",
    windowToFmt: todayShiftStart.toFormat("LLL d, h:mm a") + " ET",
  });

  try {
    await sendMail({
      to: ALERT_RECIPIENT,
      subject: `🔴 ${uncontacted.length} overnight lead${
        uncontacted.length === 1 ? "" : "s"
      } still uncalled — morning catch-up`,
      html,
    });
    for (const u of uncontacted) {
      try {
        Alerts.log({
          contactId: u.contactId,
          contactName: u.name,
          phone: u.phone,
          leadAddedAt: u.addedAt,
          minutesElapsed: u.ageMinutes,
          level: 3, // 3 = morning-catchup escalation tier
        });
      } catch {}
    }
    console.log(
      `[morning-catchup] FIRED with ${uncontacted.length} uncontacted leads (of ${inWindow.length} overnight contacts)`
    );
  } catch (e) {
    console.error("[morning-catchup] sendMail failed:", e?.message);
    result.sendError = e?.message;
  }
  return result;
}

function renderMorningCatchUpHtml({
  uncontacted,
  overnightTotal,
  windowFromFmt,
  windowToFmt,
}) {
  const rows = uncontacted
    .map(
      (u) => `
    <tr style="border-bottom:1px solid #F3F4F6">
      <td style="padding:8px 4px"><strong>${escapeHtml(u.name)}</strong></td>
      <td style="padding:8px 4px;font-variant-numeric:tabular-nums">${escapeHtml(u.phone)}</td>
      <td style="padding:8px 4px;color:#6B7280;font-size:12px">${escapeHtml(u.source)}</td>
      <td style="padding:8px 4px;color:#6B7280">${escapeHtml(u.addedAtFmt)}</td>
      <td style="padding:8px 4px"><strong style="color:#DC2626">${formatAge(u.ageMinutes)}</strong></td>
    </tr>`
    )
    .join("");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#FEF2F2;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;color:#1F2937">
<div style="max-width:720px;margin:0 auto;padding:24px 18px">
<div style="background:#DC2626;color:#fff;border-radius:12px;padding:16px 20px;margin-bottom:14px">
<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;opacity:.85">Morning catch-up</div>
<div style="font-size:18px;font-weight:700;line-height:1.2">🔴 ${uncontacted.length} overnight lead${uncontacted.length === 1 ? "" : "s"} still uncalled at 8:15 AM</div>
</div>
<div style="background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:18px 22px">
<p style="margin:0 0 14px;font-size:14px;color:#1F2937">These leads arrived between <strong>${escapeHtml(windowFromFmt)}</strong> and <strong>${escapeHtml(windowToFmt)}</strong>. Dispatchers have had 15 minutes since shift start (8:00 AM ET) and none of them have been called or transferred yet.</p>
<table style="font-size:13px;line-height:1.6;width:100%;border-collapse:collapse">
<thead><tr style="text-align:left;color:#6B7280;font-size:11px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #E5E7EB">
<th style="padding:8px 4px">Lead</th>
<th style="padding:8px 4px">Phone</th>
<th style="padding:8px 4px">Source</th>
<th style="padding:8px 4px">Arrived</th>
<th style="padding:8px 4px">Age</th>
</tr></thead>
<tbody>${rows}</tbody>
</table>
<div style="margin-top:14px;padding-top:14px;border-top:1px solid #E5E7EB;font-size:12px;color:#6B7280">
${uncontacted.length} of ${overnightTotal} overnight leads still uncalled. No further alerts will fire for these — they roll into the regular daily metrics from here. This summary fires once a day at 8:15 AM ET.
</div>
</div>
<p style="color:#6B7280;font-size:12px;margin-top:14px;text-align:center">Local AC Reports Bot · morning catch-up v1</p>
</div>
</body></html>`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAge(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}
