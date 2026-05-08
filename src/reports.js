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
import { Reports, Calls, classifyCall, isLiveTransfer } from "./db.js";
import { DateTime } from "luxon";

// Three buckets for outbound calls (legacy template shape):
//   real     >= 70s — actual conversation with the lead
//   voicemail 5..70s OR meta.call.status === "voicemail" — left a message
//   attempt  < 5s OR status in {failed, no-answer, busy, canceled} — didn't connect
//
// May 8 2026: threshold raised from 30s → 70s per Alex. Short engagements
// under 70s get bucketed as no-answer/voicemail rather than real calls.
// Live Transfers (≥70s + transferred) are tracked SEPARATELY in dispatcher.liveTransfers
// rather than being lumped into "real" — see classifyCall() in db.js.
const REAL_CALL_THRESHOLD_SEC = 70;
const VOICEMAIL_MIN_SEC = 5;

// Pipeline scope: dispatcher report only counts calls into leads that have an
// opportunity in one of these pipelines. Tampa Pipeline added May 7 2026 per
// Alex — Tampa is now active. Other named pipelines (Generator, Water
// Filtration ×2) are still inactive. To widen scope, add the pipeline NAME
// (must match the GHL pipeline name exactly) to this array.
const REPORTED_PIPELINE_NAMES = ["Orlando Pipeline", "Tampa Pipeline"];

function bucketCall(durationSec, status) {
  const dur = Number(durationSec) || 0;
  const st = String(status || "").toLowerCase();
  if (st === "voicemail" || (dur >= VOICEMAIL_MIN_SEC && dur < REAL_CALL_THRESHOLD_SEC)) {
    return "voicemail";
  }
  if (dur >= REAL_CALL_THRESHOLD_SEC) return "real";
  return "attempt";
}

// GHL returns calls with type=1 (numeric) AND messageType="TYPE_CALL" (string).
// Accept all three forms.
function isCallMessage(m) {
  return (
    m.type === 1 ||
    m.messageType === "TYPE_CALL" ||
    /CALL/i.test(String(m.type ?? ""))
  );
}

// Vonage call note: dispatchers write a note starting with "Called" whenever
// they call via Vonage (since Vonage has no API for regular accounts).
// Match strict prefix to avoid false positives. Suffix carries the result
// ("- spoke", "- voicemail", "- no answer") which buckets the call.
function parseVonageNote(noteBody) {
  const body = String(noteBody || "").trim();
  if (!/^called\b/i.test(body)) return null;
  const lower = body.toLowerCase();
  let bucket = "attempt"; // default if no qualifier — they tried, didn't connect
  if (/spoke|talked|discussed|connected|booked/.test(lower)) bucket = "real";
  else if (/voicemail|\bvm\b|left.*message/.test(lower)) bucket = "voicemail";
  return { bucket, body };
}

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

  // Daily activity rows give us the TRUE percentage (0–100). The per-slot
  // /activities endpoint returns `overall` as raw input-event counts, NOT a
  // percentage — that's what produced the 531% / 156% nonsense in the v5
  // report. We pull both: per-slot for the hourly breakdown, daily for the
  // headline activity %.
  const dailyDate = from.setZone(TZ).toFormat("yyyy-LL-dd");
  const [activities, timesheets, dailyActivities] = await Promise.all([
    hubstaff.getActivities({ from: fromIso, to: toIso, userIds }).catch(() => []),
    hubstaff.getTimesheets({ from: fromIso, to: toIso, userIds }).catch(() => []),
    hubstaff
      .getDailyActivities({ date: dailyDate, userIds })
      .catch(() => []),
  ]);
  const dailyByUser = new Map();
  for (const d of dailyActivities) {
    dailyByUser.set(d.user_id, d);
  }

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

  // CRITICAL FIX (May 7 2026 22:00 ET): Hubstaff's per-slot `overall` field
  // is the count of ACTIVE SECONDS in the slot (not a 0-100 percentage). The
  // old code multiplied tracked × (overall/100), which only made sense if
  // overall were already a percent. Verified against /admin/debug/raw:
  // Frank's slots show tracked=600 + overall=14 etc. → activity=14/600=2.3%.
  // The fix: `overall` is itself the active-seconds, use it directly.
  for (const a of activities) {
    const slot = perEmp.get(a.user_id);
    if (!slot) continue;
    const hour = hourBucket(DateTime.fromISO(a.starts_at || a.time_slot).setZone(TZ));
    const cur = slot.hourly.get(hour) || { trackedSec: 0, activeSec: 0 };
    cur.trackedSec += a.tracked || 0;
    cur.activeSec += a.overall || 0;
    slot.hourly.set(hour, cur);
    slot.totalTrackedSec += a.tracked || 0;
    slot.totalActiveSec += a.overall || 0;
  }

  // Clock-in / clock-out from timesheets — but Hubstaff's /timesheets endpoint
  // returns ZERO rows (verified May 7 2026 via /admin/debug/raw — Frank had
  // 81 activity slots and 47738s tracked, but timesheets_count=0). Endpoint
  // is broken/deprecated. Loop kept for forward-compat if Hubstaff fixes it.
  for (const ts of timesheets) {
    const slot = perEmp.get(ts.user_id);
    if (!slot) continue;
    const start = ts.starts_at ? DateTime.fromISO(ts.starts_at).setZone(TZ) : null;
    const stop = ts.stops_at ? DateTime.fromISO(ts.stops_at).setZone(TZ) : null;
    if (start && (!slot.firstClockIn || start < slot.firstClockIn)) slot.firstClockIn = start;
    if (stop && (!slot.lastClockOut || stop > slot.lastClockOut)) slot.lastClockOut = stop;
  }

  // FALLBACK (added May 7 2026): derive clock-in/out from the activities
  // array since /timesheets is broken. First activity's starts_at = clock-in.
  // Last activity's starts_at + 10 min slot duration = clock-out.
  for (const [userId, slot] of perEmp.entries()) {
    if (slot.firstClockIn && slot.lastClockOut) continue;
    const acts = activities
      .filter((a) => a.user_id === userId && (a.starts_at || a.time_slot))
      .sort((a, b) =>
        new Date(a.starts_at || a.time_slot) - new Date(b.starts_at || b.time_slot)
      );
    if (acts.length === 0) continue;
    if (!slot.firstClockIn) {
      slot.firstClockIn = DateTime.fromISO(acts[0].starts_at || acts[0].time_slot).setZone(TZ);
    }
    if (!slot.lastClockOut) {
      // Each Hubstaff activity slot covers 10 minutes
      slot.lastClockOut = DateTime
        .fromISO(acts[acts.length - 1].starts_at || acts[acts.length - 1].time_slot)
        .setZone(TZ)
        .plus({ minutes: 10 });
    }
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
  //
  // Inclusion rule: only employees we actually want to MEASURE on this report.
  // That's everyone with a Hubstaff record (so we have hours/activity for them)
  // PLUS dispatchers (so Mark — dispatcher_training, no Hubstaff yet — still
  // shows up). Sal (sales_manager) and Christopher (service_manager) are
  // back-office and were never supposed to appear here, so we explicitly
  // filter them out even though they live in the EMPLOYEES array (they are
  // kept there only so live-transfer attribution can resolve to them).
  const perEmployee = [];
  for (const e of matched) {
    const shift = expectedShiftFor(e, today);
    const showInReport = isDispatcher(e) || e.role === "office_manager" || !!e.hubstaffUserId;
    if (!showInReport) continue;

    if (!e.hubstaffUserId) {
      // Mark / any other dispatcher in GHL but not yet in Hubstaff — render a
      // placeholder row. Section 2 (GHL dispatcher analysis) still includes
      // them by ghlEmail.
      perEmployee.push({
        name: e.name,
        role: e.role,
        clockIn: null,
        clockOut: null,
        workedMinutes: 0,
        breakMinutes: null,
        breakOver: false,
        activityPct: null,
        activityFlag: false,
        statusFlag: { text: "no Hubstaff yet", color: "gray" },
        noHubstaff: true,
      });
      continue;
    }

    const slot = perEmp.get(e.hubstaffUserId);
    if (!slot) continue;
    const workedMinutes = slot.totalTrackedSec / 60;
    // CRITICAL FIX (May 7 2026): Hubstaff's daily.overall is ACTIVE-SECONDS
    // (not a percentage). Real activity % = overall / tracked × 100.
    // Verified: Frank today overall=7358 tracked=47738 → 15% activity.
    // Old code treated `overall` as a percent and capped it at 100, hiding the
    // bug for high-tracked users (everyone showed 100%) and inflating it
    // bizarrely for short shifts.
    const dailyRow = dailyByUser.get(e.hubstaffUserId);
    const dailyOverall = Number(dailyRow?.overall || 0);
    const dailyTracked = Number(dailyRow?.tracked || 0);
    const activityPct =
      dailyTracked > 0
        ? Math.max(0, Math.min(100, Math.round((dailyOverall / dailyTracked) * 100)))
        : 0;
    // Break = (clockOut - clockIn) - tracked. Approximate.
    let breakMinutes = null;
    if (slot.firstClockIn && slot.lastClockOut) {
      const shiftMin = slot.lastClockOut.diff(slot.firstClockIn, "minutes").minutes;
      breakMinutes = Math.max(0, shiftMin - workedMinutes);
    }
    const breakBudget = e.breakMinutesPerShift ?? 0;
    const breakOver = breakMinutes != null && breakMinutes > breakBudget + 5; // 5-min grace

    // Smarter "really not working" red flag: combine signals rather than fire
    // on activity-% alone. Activity % can dip during phone calls (no kbd/mouse)
    // so we only flag red when activity is low AND the dispatcher's GHL call
    // count for the same window is also tiny. Computed lower, after we know
    // each dispatcher's GHL totals — see `applyCombinedStatusFlags` below.
    let statusFlag = null;
    if (!slot.firstClockIn && shift) {
      statusFlag = { text: "no clock-in", color: "amber" };
    } else if (workedMinutes < 60 && shift) {
      statusFlag = { text: "under 1h tracked", color: "amber" };
    } else if (breakOver) {
      statusFlag = { text: `break over (${Math.round(breakMinutes - breakBudget)}m extra)`, color: "amber" };
    }
    // The "low activity" red flag is no longer set here; it's set in the
    // composeReport step once we can correlate Hubstaff activity with GHL
    // outbound-call counts.

    perEmployee.push({
      name: e.name,
      role: e.role,
      clockIn: slot.firstClockIn ? slot.firstClockIn.toFormat("h:mm a") : null,
      clockOut: slot.lastClockOut && slot.lastClockOut < now() ? slot.lastClockOut.toFormat("h:mm a") : (slot.firstClockIn ? "still on" : null),
      workedMinutes,
      breakMinutes,
      breakOver,
      activityPct,
      activityFlag: false, // set in composeReport once GHL data is joined
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

  // Use listActiveConversations (paginated by lastMessageDate) — the old
  // searchConversations(startDate,endDate) only returned conversations CREATED
  // in the window, missing all activity on older leads.
  const [pipelines, allConversations, ghlUsers] = await Promise.all([
    ghl.listPipelines().catch(() => []),
    ghl.listActiveConversations({ from: fromIso, to: toIso }).catch(() => []),
    ghl.listUsers().catch(() => []),
  ]);

  // Identify the reported pipeline(s) — currently just "Orlando Pipeline".
  const reportedPipelines = pipelines.filter((p) =>
    REPORTED_PIPELINE_NAMES.includes(p.name)
  );
  const reportedPipelineIds = new Set(reportedPipelines.map((p) => p.id));

  // Build a map of contactId → { stageName, pipelineName } for every contact
  // that has an opportunity in our reported pipeline(s). Calls to contacts NOT
  // in this set are excluded from the dispatcher report.
  const contactStage = new Map(); // contactId → { stage, pipeline, opportunityId }
  for (const p of reportedPipelines) {
    const stageById = new Map((p.stages || []).map((s) => [s.id, s.name]));
    // Pull opportunities across all statuses (open, won, lost, abandoned)
    const opps = [];
    for (const status of ["open", "won", "lost", "abandoned"]) {
      const got = await ghl
        .searchOpportunities({ pipelineId: p.id, status, limit: 100 })
        .catch(() => []);
      opps.push(...got);
    }
    for (const o of opps) {
      const cid = o.contactId || o.contact?.id;
      if (!cid) continue;
      // If a contact has multiple opportunities, keep the most recently updated.
      const stage = stageById.get(o.pipelineStageId) || o.pipelineStageName || "(unknown stage)";
      const existing = contactStage.get(cid);
      if (!existing || new Date(o.updatedAt || 0) > new Date(existing.updatedAt || 0)) {
        contactStage.set(cid, {
          stage,
          pipeline: p.name,
          opportunityId: o.id,
          updatedAt: o.updatedAt,
          // oppDateAdded = when the opportunity itself was created. Used to detect
          // leads that were ADDED RETROACTIVELY to the pipeline (manual drag-in
          // from an old contact) vs. genuinely new inbound leads where the contact
          // and opp are created within a few minutes of each other.
          oppDateAdded: o.dateAdded || o.createdAt || null,
        });
      }
    }
  }

  // Filter conversations to those whose contact has an Orlando Pipeline opportunity.
  const conversations = allConversations.filter((c) =>
    c.contactId && contactStage.has(c.contactId)
  );

  const dispatcherEmployees = EMPLOYEES.filter(isDispatcher);
  const ghlByEmail = new Map(
    ghlUsers.map((u) => [(u.email || "").toLowerCase(), u])
  );

  // Build dispatcher records with the v4 bucket shape.
  function emptyHourSlot() {
    return { real: 0, voicemail: 0, attempt: 0, sms: 0 };
  }
  function emptyLeadAge() {
    return { today: 0, "1to3": 0, "4to7": 0, "8plus": 0 };
  }
  const byDispatcher = new Map();
  for (const e of dispatcherEmployees) {
    const ghlEmail = (e.ghlEmail || e.hubstaffEmail || "").toLowerCase();
    const ghlUser = ghlByEmail.get(ghlEmail);
    byDispatcher.set(e.name, {
      name: e.name,
      role: e.role,
      ghlUserId: ghlUser?.id,
      // Headline counts (post-Orlando-filter)
      real: 0,
      voicemail: 0,
      attempt: 0,
      vonage_real: 0,
      vonage_voicemail: 0,
      vonage_attempt: 0,
      sms: 0,
      callDurationsSec: [],
      firstCallAt: null,
      lastCallAt: null,
      hourly: new Map(),
      // Per-stage call totals (Orlando Pipeline stages)
      byStage: new Map(), // stageName -> { real, voicemail, attempt }
      // Lead age breakdown — counted per outbound call+note
      leadAge: emptyLeadAge(),
      // Unique contacts called (for Avg-attempts-per-contact + Unique-leads metric)
      uniqueContacts: new Set(),
      buckets: includeTimeOfDay
        ? {
            morning: emptyHourSlot(),
            noon: emptyHourSlot(),
            afternoon: emptyHourSlot(),
          }
        : null,
    });
  }

  // Helper: classify lead age based on the contact's createdAt vs the report `to` time
  function leadAgeBucket(leadAddedDate) {
    if (!leadAddedDate) return null;
    const ageDays = to.diff(DateTime.fromISO(leadAddedDate).setZone(TZ), "days").days;
    if (ageDays < 1) return "today";
    if (ageDays < 4) return "1to3";
    if (ageDays < 8) return "4to7";
    return "8plus";
  }

  function bucketFor(dt) {
    const h = dt.setZone(TZ).hour;
    if (h < 12) return "morning";
    if (h < 16) return "noon";
    return "afternoon";
  }
  function recordEvent(dispatcher, dt, kind) {
    const hourKey = hourBucket(dt);
    const slot = dispatcher.hourly.get(hourKey) || emptyHourSlot();
    slot[kind] = (slot[kind] || 0) + 1;
    dispatcher.hourly.set(hourKey, slot);
    if (includeTimeOfDay && dispatcher.buckets) {
      const b = bucketFor(dt);
      dispatcher.buckets[b][kind] = (dispatcher.buckets[b][kind] || 0) + 1;
    }
  }

  // Notes are CONTACT-scoped, not conversation-scoped. If a contact has 2
  // conversations (e.g. one for SMS, one for calls — extremely common in GHL)
  // we used to fetch and count its notes once per conversation, double-counting
  // every Vonage "Called …" record. We now dedupe two ways:
  //   1. Cache `getContactNotes` results per contactId so we make one HTTP call.
  //   2. Track which (contactId, noteId) pairs we've already counted so
  //      walking the same contact twice never tallies the same note twice.
  // This is the root cause of Angel's wildly inflated 13-voicemail count.
  const contactNotesCache = new Map();
  const countedVonageNotes = new Set(); // `${contactId}:${noteId}` keys
  async function notesFor(contactId) {
    if (!contactId) return [];
    if (contactNotesCache.has(contactId))
      return contactNotesCache.get(contactId);
    const list = await ghl.getContactNotes(contactId).catch(() => []);
    contactNotesCache.set(contactId, list);
    return list;
  }

  // Walk every active conversation: count outbound SMS only. Calls are now
  // counted from the local `calls` table (populated by the GHL webhook +
  // firehose backfill) — see the Calls.listInWindow loop below. This swap
  // fixed the "100-conversation pagination cap" undercount that made the
  // old report show 273 outbound calls when GHL's API actually had 388.
  for (const conv of conversations) {
    const leadAge = leadAgeBucket(conv.dateAdded);
    const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
    for (const m of msgs) {
      const dir = String(m.direction ?? "").toLowerCase();
      if (dir !== "outbound") continue;
      const userId = m.userId || m.user || m.createdBy;
      const dispatcher = [...byDispatcher.values()].find(
        (d) => d.ghlUserId === userId
      );
      if (!dispatcher) continue;
      const dt = DateTime.fromISO(
        m.dateAdded || m.createdAt || new Date().toISOString()
      ).setZone(TZ);
      // Restrict to the report window
      if (dt < from || dt > to) continue;

      // Calls used to be counted here from messages — now sourced from the
      // calls table below. This branch only handles SMS now.
      if (m.type === 2 || m.messageType === "TYPE_SMS") {
        // Skip workflow-bot auto-texts (no userId) — only count manual sends
        if (!userId) continue;
        dispatcher.sms += 1;
        recordEvent(dispatcher, dt, "sms");
      }
    }

    // Vonage notes: any note from a known dispatcher starting with "Called"
    // counts as a call, with bucket inferred from the suffix. Notes are cached
    // per-contact and deduped by note id so a contact with multiple
    // conversations does not over-count.
    if (conv.contactId) {
      const notes = await notesFor(conv.contactId);
      for (const n of notes) {
        const parsed = parseVonageNote(n.body);
        if (!parsed) continue;
        const dedupeKey = `${conv.contactId}:${n.id || n.dateAdded || n.body}`;
        if (countedVonageNotes.has(dedupeKey)) continue;
        countedVonageNotes.add(dedupeKey);
        const dispatcher = [...byDispatcher.values()].find(
          (d) => d.ghlUserId === n.userId
        );
        if (!dispatcher) continue;
        const dt = DateTime.fromISO(
          n.dateAdded || new Date().toISOString()
        ).setZone(TZ);
        if (dt < from || dt > to) continue;
        // Tally Vonage separately so we can show a "V" badge in the UI later
        const vKey =
          parsed.bucket === "real"
            ? "vonage_real"
            : parsed.bucket === "voicemail"
              ? "vonage_voicemail"
              : "vonage_attempt";
        dispatcher[vKey] += 1;
        // Also fold into the main bucket totals so the headline numbers are honest
        dispatcher[parsed.bucket] += 1;
        recordEvent(dispatcher, dt, parsed.bucket);
        if (!dispatcher.firstCallAt || dt < dispatcher.firstCallAt)
          dispatcher.firstCallAt = dt;
        if (!dispatcher.lastCallAt || dt > dispatcher.lastCallAt)
          dispatcher.lastCallAt = dt;
        // Per-stage tally
        const stageInfo = contactStage.get(conv.contactId);
        if (stageInfo) {
          const sn = stageInfo.stage;
          const slot = dispatcher.byStage.get(sn) || { real: 0, voicemail: 0, attempt: 0 };
          slot[parsed.bucket] += 1;
          dispatcher.byStage.set(sn, slot);
        }
        if (conv.contactId) dispatcher.uniqueContacts.add(conv.contactId);
        if (leadAge) dispatcher.leadAge[leadAge] += 1;
      }
    }
  }

  // ---------- Calls from local DB (replaces /conversations/search call walk) ----------
  // Source-of-truth for all HL native calls is the `calls` table, populated by
  // the GHL webhook (real-time) + nightly firehose-backfill (reconcile). This
  // is unfiltered — every outbound call from any dispatcher counts. The old
  // /conversations/search path silently capped at 100 conversations and
  // undercounted by ~30% (e.g. May 7: API said 273, firehose says 545).
  //
  // Bucket mapping (5-bucket → 3-bucket template shape):
  //   live_transfer  → dispatcher.liveTransfers (separate field, not real)
  //   real_call      → dispatcher.real
  //   no_answer      → dispatcher.attempt
  //   failed         → dispatcher.attempt
  //   ringing        → dispatcher.attempt
  //   (voicemail bucket dropped — under 70s gets bucketed as no_answer)
  const callsFromDb = Calls.listInWindow(fromIso, toIso, 5000);
  for (const c of callsFromDb) {
    if (c.direction !== "outbound") continue;
    const dispatcher = [...byDispatcher.values()].find(
      (d) => d.ghlUserId === c.user_id
    );
    if (!dispatcher) continue;
    const dt = DateTime.fromISO(c.date_added).setZone(TZ);
    if (dt < from || dt > to) continue;

    let raw = {};
    try {
      if (c.raw_event) raw = JSON.parse(c.raw_event);
    } catch {}
    const bucket = classifyCall({
      status: c.status,
      duration: c.duration,
      participants: raw.participants,
    });

    let templateBucket = null;
    if (bucket === "live_transfer") {
      // Live transfers are tracked separately, NOT in real/voicemail/attempt
      // (the bookings section initializes liveTransfers = 0 — increment safely
      // even before that init by ensuring the field exists)
      dispatcher.liveTransfers = (dispatcher.liveTransfers || 0) + 1;
    } else if (bucket === "real_call") {
      dispatcher.real += 1;
      templateBucket = "real";
      if (c.duration) dispatcher.callDurationsSec.push(c.duration);
    } else {
      // no_answer / failed / ringing all roll up into "attempt"
      dispatcher.attempt += 1;
      templateBucket = "attempt";
    }

    if (templateBucket) recordEvent(dispatcher, dt, templateBucket);
    if (!dispatcher.firstCallAt || dt < dispatcher.firstCallAt)
      dispatcher.firstCallAt = dt;
    if (!dispatcher.lastCallAt || dt > dispatcher.lastCallAt)
      dispatcher.lastCallAt = dt;

    // Per-stage tally (Orlando Pipeline) — only when the contact is known
    // and in our pipeline. Live transfers don't count toward the per-stage
    // breakdown of real/voicemail/attempt because they're a fourth thing.
    const stageInfo = c.contact_id ? contactStage.get(c.contact_id) : null;
    if (stageInfo && templateBucket) {
      const sn = stageInfo.stage;
      const slot = dispatcher.byStage.get(sn) || {
        real: 0,
        voicemail: 0,
        attempt: 0,
      };
      slot[templateBucket] += 1;
      dispatcher.byStage.set(sn, slot);
    }
    if (c.contact_id) dispatcher.uniqueContacts.add(c.contact_id);
  }

  // Initialize per-dispatcher booking counters (new shape).
  // liveTransfers may have been incremented above by the calls walk; only
  // initialize fields that don't already exist so we don't clobber it.
  for (const d of byDispatcher.values()) {
    d.physBookings = 0; // appointment booked, physical visit
    d.phBookings = 0; // over phone sale (booked phone appointment)
    if (typeof d.liveTransfers !== "number") d.liveTransfers = 0;
  }

  // Appointments booked / Over Phone Sale / Live transfer
  // Recognized stages (Orlando Pipeline naming):
  //   - "Appt. Booked" / "Appointment Booked"  → physical booking
  //   - "Over Phone Booked" / "Over Phone Sale" → phone-sale booking (PH appointment)
  //   - "Live Transfer"                         → transferred immediately to sales
  const appointmentsBooked = [];
  const bucketBookings = { morning: 0, noon: 0, afternoon: 0 };
  for (const p of reportedPipelines) {
    const opps = await ghl
      .searchOpportunities({ pipelineId: p.id, status: "open" })
      .catch(() => []);
    for (const o of opps) {
      const stage = String(o.pipelineStageName ?? "").toLowerCase();
      const isPhys = stage.includes("appointment booked") || stage.includes("appt. booked") || stage.includes("appt booked");
      const isPh = stage.includes("over phone sale") || stage.includes("over phone booked") || stage.includes("phone sale");
      const isXfer = stage.includes("live transfer");
      if (!isPhys && !isPh && !isXfer) continue;

      // Only count bookings whose OPP was CREATED inside this report window.
      // Previously we used `updatedAt`, which changes on any opp edit (a call
      // logged, a tag added, even a phone-format cleanup). That made already-
      // booked leads show up as "newly booked today" the moment a dispatcher
      // touched them — exactly the bug Alex saw with Frank's 2 bookings on
      // May 7. `dateAdded` is when the opp was first created, which is a
      // tighter (and accurate-by-default) proxy for "booked in this window."
      const created = DateTime.fromISO(
        o.dateAdded || o.createdAt || ""
      ).setZone(TZ);
      if (!created.isValid) continue;
      if (created < from || created > to) continue;

      const dispatcher =
        [...byDispatcher.values()].find((d) => d.ghlUserId === o.assignedTo) || {
          name: "—",
        };
      if (isPhys && dispatcher.physBookings != null) dispatcher.physBookings += 1;
      if (isPh && dispatcher.phBookings != null) dispatcher.phBookings += 1;
      if (isXfer && dispatcher.liveTransfers != null)
        dispatcher.liveTransfers += 1;
      appointmentsBooked.push({
        leadName: o.contact?.name || o.name || "(unnamed)",
        time: fmtTime(created),
        dispatcher: dispatcher.name,
        stage: o.pipelineStageName,
        kind: isPhys ? "physical" : isPh ? "phone_sale" : "live_transfer",
      });
      if (includeTimeOfDay) bucketBookings[bucketFor(created)] += 1;
    }
  }

  // New-lead response time — only NEW leads in the window. Use isCallMessage
  // (handles numeric type=1) and also consider Vonage notes as a "first call".
  //
  // CRITICAL Orlando-only filter: we ONLY count leads that arrived as genuinely
  // new inbound leads to the Orlando Pipeline. Excluded:
  //   - leads not in Orlando Pipeline at all
  //   - leads where the Orlando opp was created HOURS after the contact
  //     (= old contact dragged into the pipeline retroactively, e.g. someone
  //     manually re-pipelined an old lead today). Real new leads have the
  //     contact and the opp created within a few minutes of each other.
  const ORLANDO_NEW_OPP_WINDOW_MIN = 60;
  const newLeads = await ghl
    .searchContacts({ from: fromIso, to: toIso, limit: 100 })
    .catch(() => []);
  const responseTimeAlerts = [];
  // Orlando-NEW response time samples (used for averages — per requirement)
  const orlandoResponseSamples = []; // { dispatcher, delayMinutes }
  for (const c of newLeads) {
    const created = DateTime.fromISO(c.dateAdded).setZone(TZ);
    let firstCallAt = null;
    let firstCallBy = null;
    const conv = conversations.find((cv) => cv.contactId === c.id);
    if (conv) {
      const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
      const calls = msgs
        .filter(isCallMessage)
        .filter(
          (m) => String(m.direction ?? "").toLowerCase() === "outbound"
        );
      if (calls.length) {
        calls.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
        firstCallAt = DateTime.fromISO(calls[0].dateAdded).setZone(TZ);
        const userId = calls[0].userId;
        firstCallBy = [...byDispatcher.values()].find(
          (d) => d.ghlUserId === userId
        )?.name;
      }
      // Also check Vonage notes — earliest "Called -" note from a dispatcher
      // (uses the cached notes fetched earlier so we don't re-hit the API).
      const notes = await notesFor(c.id);
      for (const n of notes) {
        if (!parseVonageNote(n.body)) continue;
        const noteAt = DateTime.fromISO(n.dateAdded || "").setZone(TZ);
        if (!noteAt.isValid) continue;
        if (noteAt < created) continue;
        if (!firstCallAt || noteAt < firstCallAt) {
          firstCallAt = noteAt;
          firstCallBy = [...byDispatcher.values()].find(
            (d) => d.ghlUserId === n.userId
          )?.name;
        }
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

    // Decide if this lead qualifies as Orlando-NEW for the average metric.
    const stageInfo = contactStage.get(c.id);
    if (!stageInfo) continue; // not in Orlando Pipeline at all
    if (!firstCallAt) continue; // can't compute response time if no contact attempt
    const oppDateAdded = stageInfo.oppDateAdded;
    if (oppDateAdded) {
      const oppCreated = DateTime.fromISO(oppDateAdded).setZone(TZ);
      const gapMin = Math.abs(oppCreated.diff(created, "minutes").minutes);
      if (gapMin > ORLANDO_NEW_OPP_WINDOW_MIN) continue; // retroactively added
    }
    orlandoResponseSamples.push({
      dispatcher: firstCallBy,
      delayMinutes,
    });
  }

  // Compute averages: overall + per-dispatcher
  const round1 = (n) => Math.round(n * 10) / 10;
  const avgResponseMinOverall = orlandoResponseSamples.length
    ? round1(
        orlandoResponseSamples.reduce((s, r) => s + r.delayMinutes, 0) /
          orlandoResponseSamples.length
      )
    : null;
  const responseByDispatcher = new Map();
  for (const r of orlandoResponseSamples) {
    if (!r.dispatcher) continue;
    const arr = responseByDispatcher.get(r.dispatcher) || [];
    arr.push(r.delayMinutes);
    responseByDispatcher.set(r.dispatcher, arr);
  }
  const avgResponseMinByDispatcher = {};
  const newLeadsCountByDispatcher = {};
  for (const [name, arr] of responseByDispatcher) {
    avgResponseMinByDispatcher[name] = round1(
      arr.reduce((s, x) => s + x, 0) / arr.length
    );
    newLeadsCountByDispatcher[name] = arr.length;
  }

  // Build per-dispatcher final shape using the new bucket model.
  const byDispatcherOut = [];
  for (const d of byDispatcher.values()) {
    const hourly = [...d.hourly.entries()].sort().map(([k, v]) => ({
      label: formatHourLabel(k),
      real: v.real || 0,
      voicemail: v.voicemail || 0,
      attempt: v.attempt || 0,
      sms: v.sms || 0,
      // Backward-compat aliases for old template
      calls: (v.real || 0) + (v.voicemail || 0),
      attempts: v.attempt || 0,
    }));
    const avgCallSec = d.callDurationsSec.length
      ? d.callDurationsSec.reduce((a, b) => a + b, 0) / d.callDurationsSec.length
      : null;
    const totalBookings = d.physBookings + d.phBookings;
    // Booking ratio = bookings ÷ real calls (only). Suppress when too few real
    // calls to avoid 1/1 = 100% headlines that mislead.
    const bookingRatio =
      d.real >= 5 ? Math.round((totalBookings / d.real) * 100) : null;
    const totalDials = d.real + d.voicemail + d.attempt;
    const uniqueLeads = d.uniqueContacts.size;
    const avgAttemptsPerContact = uniqueLeads > 0
      ? Math.round((totalDials / uniqueLeads) * 10) / 10
      : null;
    // Build per-stage table in pipeline order (so all 11 Orlando stages appear,
    // even with zero counts — keeps the table consistent across dispatchers).
    const stageOrder = reportedPipelines.flatMap((p) => (p.stages || []).map((s) => s.name));
    const seen = new Set();
    const byStage = [];
    for (const sn of stageOrder) {
      if (seen.has(sn)) continue;
      seen.add(sn);
      const slot = d.byStage.get(sn) || { real: 0, voicemail: 0, attempt: 0 };
      byStage.push({
        stage: sn,
        real: slot.real,
        voicemail: slot.voicemail,
        attempt: slot.attempt,
        total: slot.real + slot.voicemail + slot.attempt,
      });
    }
    byDispatcherOut.push({
      name: d.name,
      role: d.role,
      // Headline counts — new bucket shape
      real: d.real,
      voicemail: d.voicemail,
      attempt: d.attempt,
      // Backward-compat aliases for the old template
      calls: d.real + d.voicemail,
      attempts: d.attempt,
      bookings: d.physBookings + d.phBookings,
      vonage: {
        real: d.vonage_real,
        voicemail: d.vonage_voicemail,
        attempt: d.vonage_attempt,
      },
      sms: d.sms,
      physBookings: d.physBookings,
      phBookings: d.phBookings,
      liveTransfers: d.liveTransfers,
      bookingRatio,
      avgCallSec,
      firstCallAt: d.firstCallAt ? d.firstCallAt.toFormat("h:mm a") : null,
      lastCallAt: d.lastCallAt ? d.lastCallAt.toFormat("h:mm a") : null,
      hourly,
      // v4 metrics
      uniqueLeads,
      avgAttemptsPerContact,
      leadAge: { ...d.leadAge },
      byStage,
      // v5: avg response time on Orlando NEW leads only (per-dispatcher)
      avgResponseMin: avgResponseMinByDispatcher[d.name] ?? null,
      newLeadsResponded: newLeadsCountByDispatcher[d.name] ?? 0,
    });
  }

  // Time-of-day summary (evening only) — same buckets but new shape
  let timeOfDay;
  if (includeTimeOfDay) {
    timeOfDay = BUCKETS.map((b) => {
      let real = 0,
        voicemail = 0,
        attempt = 0;
      for (const d of byDispatcher.values()) {
        real += d.buckets[b.key].real || 0;
        voicemail += d.buckets[b.key].voicemail || 0;
        attempt += d.buckets[b.key].attempt || 0;
      }
      const bookings = bucketBookings[b.key];
      let verdict, note;
      if (real + voicemail + attempt === 0) {
        verdict = "low";
        note = "No call activity";
      } else if (bookings > 0) {
        verdict = "good";
        note = `${bookings} booking${bookings === 1 ? "" : "s"}`;
      } else if (real === 0) {
        verdict = "low";
        note = "No real conversations";
      } else {
        verdict = "ok";
        note = null;
      }
      // Include legacy aliases so old template renders without crash
      return { ...b, real, voicemail, attempt, bookings, verdict, note, calls: real + voicemail, attempts: attempt };
    });
  }

  return {
    byDispatcher: byDispatcherOut,
    responseTimeAlerts,
    appointmentsBooked,
    timeOfDay,
    // v4: pipeline scope label so the email header can show it
    pipelineLabel: REPORTED_PIPELINE_NAMES.join(" + "),
    // v5: avg new-lead response time on Orlando NEW leads only
    avgResponseMinOverall,
    orlandoNewLeadsCount: orlandoResponseSamples.length,
    // Stage order across reported pipelines — used to render consistent stage tables
    stageOrder: (() => {
      const arr = [];
      const seen = new Set();
      for (const p of reportedPipelines) {
        for (const s of p.stages || []) {
          if (!seen.has(s.name)) {
            seen.add(s.name);
            arr.push(s.name);
          }
        }
      }
      return arr;
    })(),
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

// Cross-system flags: detect mismatches between Hubstaff (presence) and GHL (output).
//
//   hubstaff_silent : Hubstaff shows >= 50% activity for an hour with >= 10 min
//                     tracked, but GHL shows 0 events from that dispatcher in
//                     the same hour. Activity-padding signal.
//
//   off_clock       : GHL shows >= 1 outbound event in an hour but Hubstaff has
//                     < 1 minute tracked. Working off the clock — payroll +
//                     visibility issue.
//
// Returns [{ employee, hour, kind, detail }, ...].
function computeCrossSystemFlags(hub, dispatch) {
  const flags = [];
  const dispatcherByName = new Map(dispatch.byDispatcher.map((d) => [d.name, d]));

  for (const [, slot] of hub._byUser) {
    const empName = slot.employee.name;
    const dispatcher = dispatcherByName.get(empName);

    // ---- 1) hubstaff_silent ----
    for (const [hourKey, hubData] of slot.hourly) {
      const trackedSec = hubData.trackedSec || 0;
      const activeSec = hubData.activeSec || 0;
      if (trackedSec < 600) continue; // skip hours with <10 min tracked
      const pct = Math.round((activeSec / trackedSec) * 100);
      if (pct < 50) continue;
      const label = formatHourLabel(hourKey);
      const hourlyEntry = dispatcher?.hourly.find((h) => h.label === label);
      const ghlEvents = hourlyEntry
        ? (hourlyEntry.real || 0) + (hourlyEntry.voicemail || 0) +
          (hourlyEntry.attempt || 0) + (hourlyEntry.sms || 0)
        : 0;
      if (ghlEvents === 0 && dispatcher) {
        flags.push({
          employee: empName,
          hour: label,
          kind: "hubstaff_silent",
          detail: `${pct}% activity, 0 GHL events`,
        });
      }
    }

    // ---- 2) off_clock ---- (only check if employee is a dispatcher tracked in GHL)
    if (!dispatcher) continue;
    for (const h of dispatcher.hourly || []) {
      const ghlEvents =
        (h.real || 0) + (h.voicemail || 0) + (h.attempt || 0) + (h.sms || 0);
      if (ghlEvents === 0) continue;
      // Reverse-resolve label "8 – 9 AM" → "08:00"
      const m = h.label.match(/^(\d+)\s*[–-]\s*\d+\s*(AM|PM)/i);
      if (!m) continue;
      let hr = parseInt(m[1], 10);
      const isPM = /PM/i.test(m[2]);
      if (isPM && hr !== 12) hr += 12;
      if (!isPM && hr === 12) hr = 0;
      const hubKey = `${String(hr).padStart(2, "0")}:00`;
      const hubHour = slot.hourly.get(hubKey);
      const tracked = hubHour?.trackedSec || 0;
      if (tracked < 60) {
        flags.push({
          employee: empName,
          hour: h.label,
          kind: "off_clock",
          detail: `${ghlEvents} GHL events, no Hubstaff tracking`,
        });
      }
    }
  }

  return flags;
}

// Combined "really not working" flag. Set the red `low activity` status only
// when BOTH signals point the same way:
//   • Hubstaff activity % is below the role's expected band, AND
//   • GHL output (calls + texts) for the day is below 5 events.
// Activity % alone is unreliable for dispatchers — they're on the phone
// without keyboard input for long stretches. GHL alone is unreliable for
// Frank — he supervises and doesn't dial much. Combining the two suppresses
// the noise we saw on May 7 (red flags everywhere from a 40 % cutoff).
function applyCombinedStatusFlags(perEmployee, dispatcherRows) {
  const ghlEventsByName = new Map();
  for (const d of dispatcherRows) {
    const total =
      (d.real || 0) +
      (d.voicemail || 0) +
      (d.attempt || 0) +
      (d.sms || 0) +
      (d.physBookings || 0) +
      (d.phBookings || 0) +
      (d.liveTransfers || 0);
    ghlEventsByName.set(d.name, total);
  }
  for (const row of perEmployee) {
    if (row.noHubstaff) continue;
    if (row.statusFlag) continue; // amber flag already set — don't override
    const pct = row.activityPct;
    if (pct == null) continue;
    const ghlEvents = ghlEventsByName.get(row.name) ?? 0;
    // Frank is `dispatcher_manager` — give him a wider band.
    const lowActivity = row.role === "dispatcher_manager" ? pct < 25 : pct < 35;
    const lowGhl = row.role === "dispatcher_manager" ? ghlEvents < 2 : ghlEvents < 5;
    if (lowActivity && lowGhl) {
      row.statusFlag = {
        text: `low output (${pct}% / ${ghlEvents} events)`,
        color: "red",
      };
      row.activityFlag = true;
    }
  }
}

// ---------- Top-level orchestrators ----------

export async function runMorningReport({ dateOverride } = {}) {
  // dateOverride lets the admin debug endpoint regenerate a report for a
  // past date by anchoring `now()` to that date's noon ET (so morningWindow
  // covers that day's morning).
  const generatedAt = dateOverride
    ? DateTime.fromISO(dateOverride, { zone: TZ }).set({ hour: 12, minute: 0 })
    : now();
  const { from, to } = morningWindow(generatedAt);

  const hub = await buildHubstaffSection({ from, to, includeTotals: false });
  const dispatch = await buildDispatcherSection({ from, to, includeTimeOfDay: false });

  // Cross-reference low activity AND low calls
  const dispatcherByName = new Map(dispatch.byDispatcher.map((d) => [d.name, d]));
  for (const f of hub.lowActivityFlags) {
    const d = dispatcherByName.get(f.employee);
    if (!d) continue;
    const hourly = d.hourly.find((h) => formatHourLabel(f.hour) === h.label);
    if (hourly && (hourly.real + hourly.voicemail + hourly.attempt) <= 1) f.alsoLowCalls = true;
  }

  // v5: cross-system flags (Hubstaff active + GHL silent / GHL active + off clock)
  hub.crossSystemFlags = computeCrossSystemFlags(hub, dispatch);
  // v6: combined "low output" red flag (Hubstaff low AND GHL low)
  applyCombinedStatusFlags(hub.perEmployee, dispatch.byDispatcher);

  const html = renderEmail({
    title: "Morning Snapshot",
    generatedAt,
    sections: [renderHubstaffSection(hub), renderDispatcherSection(dispatch)],
  });

  // Archive to DB so the website /reports page can show this report later.
  // Summary JSON keeps the structured data so we can re-render with a
  // different layout/template without losing the underlying numbers.
  try {
    Reports.log({
      kind: "morning",
      html,
      summary: { hub, dispatch },
    });
  } catch (e) {
    console.error("[report] db archive failed", e?.message);
  }

  await sendMail({
    subject: `Local AC — Morning Snapshot (${generatedAt.toFormat("LLL d")})`,
    html,
  });
}

export async function runEveningReport({ dateOverride } = {}) {
  // dateOverride lets the admin debug endpoint regenerate a report for a
  // past date by anchoring `now()` to that date's 7:30 PM ET (so
  // eveningWindow covers that full day).
  const generatedAt = dateOverride
    ? DateTime.fromISO(dateOverride, { zone: TZ }).set({ hour: 19, minute: 30 })
    : now();
  const { from, to } = eveningWindow(generatedAt);

  const hub = await buildHubstaffSection({ from, to, includeTotals: true });
  const dispatch = await buildDispatcherSection({ from, to, includeTimeOfDay: true });

  const dispatcherByName = new Map(dispatch.byDispatcher.map((d) => [d.name, d]));
  for (const f of hub.lowActivityFlags) {
    const d = dispatcherByName.get(f.employee);
    if (!d) continue;
    const hourly = d.hourly.find((h) => formatHourLabel(f.hour) === h.label);
    if (hourly && (hourly.real + hourly.voicemail + hourly.attempt) <= 1) f.alsoLowCalls = true;
  }

  // v5: cross-system flags (Hubstaff active + GHL silent / GHL active + off clock)
  hub.crossSystemFlags = computeCrossSystemFlags(hub, dispatch);
  // v6: combined "low output" red flag (Hubstaff low AND GHL low)
  applyCombinedStatusFlags(hub.perEmployee, dispatch.byDispatcher);

  const html = renderEmail({
    title: "Full Day Summary",
    generatedAt,
    sections: [renderHubstaffSection(hub), renderDispatcherSection(dispatch)],
  });

  try {
    Reports.log({
      kind: "evening",
      html,
      summary: { hub, dispatch },
    });
  } catch (e) {
    console.error("[report] db archive failed", e?.message);
  }

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
    { label: "8 – 9 AM", real: base, voicemail: 1, attempt: 4, sms: 1 },
    { label: "9 – 10 AM", real: base + 1, voicemail: 2, attempt: 5, sms: 0 },
    { label: "10 – 11 AM", real: base, voicemail: 1, attempt: 3, sms: 1 },
    { label: "11 – 12 PM", real: base + 2, voicemail: 1, attempt: 6, sms: 2 },
    { label: "12 – 1 PM", real: 0, voicemail: 1, attempt: 4, sms: 1 },
    { label: "1 – 2 PM", real: base, voicemail: 0, attempt: 3, sms: 0 },
    { label: "2 – 3 PM", real: base + 1, voicemail: 1, attempt: 2, sms: 1 },
    { label: "3 – 4 PM", real: 0, voicemail: 0, attempt: 4, sms: 0 },
  ];
  return {
    byDispatcher: [
      {
        name: "Frank", role: "dispatcher_manager",
        real: 4, voicemail: 6, attempt: 39,
        vonage: { real: 0, voicemail: 0, attempt: 0 },
        sms: 3, physBookings: 2, phBookings: 0, liveTransfers: 0,
        bookingRatio: 50, avgCallSec: 142,
        firstCallAt: "8:14 AM", lastCallAt: "12:55 PM",
        hourly: sampleHourly(1),
      },
      {
        name: "Ellie", role: "dispatcher",
        real: 2, voicemail: 14, attempt: 206,
        vonage: { real: 0, voicemail: 0, attempt: 0 },
        sms: 31, physBookings: 1, phBookings: 1, liveTransfers: 1,
        bookingRatio: null, avgCallSec: 168,
        firstCallAt: "8:02 AM", lastCallAt: "12:43 PM",
        hourly: sampleHourly(0),
      },
      {
        name: "Mark", role: "dispatcher_training",
        real: 15, voicemail: 21, attempt: 84,
        vonage: { real: 0, voicemail: 0, attempt: 0 },
        sms: 8, physBookings: 2, phBookings: 1, liveTransfers: 2,
        bookingRatio: 20, avgCallSec: 119,
        firstCallAt: "8:11 AM", lastCallAt: "1:47 PM",
        hourly: sampleHourly(2),
      },
    ],
    timeOfDay: [
      { label: "Morning", hours: "until 12 PM", real: 8, voicemail: 12, attempt: 130, bookings: 3, verdict: "good", note: "3 bookings" },
      { label: "Noon", hours: "12 PM – 4 PM", real: 7, voicemail: 8, attempt: 80, bookings: 3, verdict: "good", note: "3 bookings" },
      { label: "Afternoon", hours: "4 PM – 9 PM", real: 6, voicemail: 18, attempt: 122, bookings: 1, verdict: "ok", note: null },
    ],
    responseTimeAlerts: [
      { leadName: "Maria Sanchez", dispatcher: "Frank", delayMinutes: 1.5, late: false },
      { leadName: "John Doe", dispatcher: null, delayMinutes: 8.2, late: true },
      { leadName: "Carlos Ruiz", dispatcher: "Ellie", delayMinutes: 2.1, late: false },
    ],
    appointmentsBooked: [
      { leadName: "Maria Sanchez", time: "9:14 AM", dispatcher: "Frank", stage: "Appointment Booked", kind: "physical" },
      { leadName: "Carlos Ruiz", time: "11:42 AM", dispatcher: "Ellie", stage: "Over Phone Sale", kind: "phone_sale" },
      { leadName: "Jennifer Park", time: "2:08 PM", dispatcher: "Mark", stage: "Live Transfer", kind: "live_transfer" },
    ],
  };
}
