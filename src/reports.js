// Composes the morning (12 PM) and evening (7:30 PM) reports.
// Pulls data from Hubstaff + GHL, runs analysis, builds an HTML email,
// and ships it via mailer.

import { config } from "./config.js";
import { now, morningWindow, eveningWindow, rolling24h, hourBucket, fmtDateTime, fmtTime, fmtDuration } from "./time.js";
import { EMPLOYEES, isDispatcher, expectedShiftFor } from "./employees.js";
import * as hubstaff from "./hubstaff.js";
import * as ghl from "./ghl.js";
import { analyzeScreenshots } from "./screenshots.js";
import { sendMail } from "./mailer.js";
import { renderEmail, renderHubstaffSection, renderDispatcherSection } from "./template.js";

// ---------- Hubstaff analysis ----------

async function buildHubstaffSection({ from, to, includeTotals }) {
  const fromIso = from.toUTC().toISO();
  const toIso = to.toUTC().toISO();

  // Pull org users so we can map Hubstaff user_id -> our employees
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

  // Aggregate per-employee per-hour stats
  const perEmp = new Map();
  for (const e of matched) {
    if (!e.hubstaffUserId) continue;
    perEmp.set(e.hubstaffUserId, {
      employee: e,
      hourly: new Map(), // "HH:00" -> {trackedSec, activeSec}
      totalTrackedSec: 0,
      totalActiveSec: 0,
    });
  }

  for (const a of activities) {
    const slot = perEmp.get(a.user_id);
    if (!slot) continue;
    const hour = hourBucket(new Date(a.starts_at || a.time_slot));
    const cur = slot.hourly.get(hour) || { trackedSec: 0, activeSec: 0 };
    cur.trackedSec += a.tracked || 0;
    cur.activeSec += (a.tracked || 0) * ((a.overall || 0) / 100);
    slot.hourly.set(hour, cur);
    slot.totalTrackedSec += a.tracked || 0;
    slot.totalActiveSec += (a.tracked || 0) * ((a.overall || 0) / 100);
  }

  // Discrepancy detection: did everyone show up on time?
  const today = now();
  const discrepancies = [];
  for (const e of matched) {
    if (!e.hubstaffUserId) continue;
    const shift = expectedShiftFor(e, today);
    if (!shift) continue; // off today
    const slot = perEmp.get(e.hubstaffUserId);
    if (!slot || slot.totalTrackedSec < 60) {
      discrepancies.push({
        employee: e.name,
        detail: `scheduled ${shift.start}, no tracked time yet by ${to.toFormat("h:mm a")}`,
      });
    }
  }

  // Hourly activity summary + low-activity flags
  const activitySummary = [];
  const lowActivityFlags = [];
  for (const [, slot] of perEmp) {
    const e = slot.employee;
    const hours = [...slot.hourly.entries()].sort();
    const avgPct = slot.totalTrackedSec
      ? Math.round((slot.totalActiveSec / slot.totalTrackedSec) * 100)
      : 0;
    const hourly = hours.map(([h, v]) => {
      const pct = v.trackedSec
        ? Math.round((v.activeSec / v.trackedSec) * 100)
        : 0;
      return {
        hour: h,
        pct,
        flagged: avgPct > 0 && pct > 0 && pct < avgPct - 20,
      };
    });
    for (const h of hourly) {
      if (h.flagged) {
        lowActivityFlags.push({
          employee: e.name,
          hour: h.hour,
          detail: `${h.pct}% (own avg ${avgPct}%)`,
          alsoLowCalls: false, // populated by dispatcher cross-ref later
        });
      }
    }
    activitySummary.push({ employee: e.name, avgPct, hourly });
  }

  // Screenshot manipulation detection — only run if we have userIds
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
          windowLabel: `${fmtTime(new Date(f.windowStart))} – ${fmtTime(new Date(f.windowEnd))}`,
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

  const allClean =
    discrepancies.length === 0 &&
    lowActivityFlags.length === 0 &&
    manipulationFlags.length === 0;

  return {
    allClean,
    discrepancies,
    activitySummary,
    lowActivityFlags,
    manipulationFlags,
    totalsByEmployee,
    _byUser: perEmp, // exposed so dispatcher report can cross-reference
  };
}

// ---------- GHL dispatcher analysis ----------

async function buildDispatcherSection({ from, to, hubstaffByUser }) {
  const fromIso = from.toUTC().toISO();
  const toIso = to.toUTC().toISO();

  const [pipelines, conversations, ghlUsers] = await Promise.all([
    ghl.listPipelines().catch(() => []),
    ghl.searchConversations({ from: fromIso, to: toIso, limit: 100 }).catch(() => []),
    ghl.listUsers().catch(() => []),
  ]);

  // Map dispatchers
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
      total: 0,
      under25: 0,
      over25: 0,
      bookings: 0,
      callsByHour: new Map(),
    });
  }

  // Pull all messages from each conversation, count calls
  for (const conv of conversations) {
    const msgs = await ghl
      .getConversationMessages(conv.id)
      .catch(() => []);
    for (const m of msgs) {
      if ((m.type || "").toUpperCase() !== "CALL") continue;
      const userId = m.userId || m.user || m.createdBy;
      const dispatcher = [...byDispatcher.values()].find(
        (d) => d.ghlUserId === userId
      );
      if (!dispatcher) continue;
      dispatcher.total += 1;
      const dur = m.callDuration ?? m.duration ?? 0;
      if (dur < 25) dispatcher.under25 += 1;
      else dispatcher.over25 += 1;
      const hour = hourBucket(new Date(m.dateAdded || m.createdAt));
      dispatcher.callsByHour.set(
        hour,
        (dispatcher.callsByHour.get(hour) || 0) + 1
      );
    }
  }

  // Appointments booked / Over Phone Sale
  const appointmentsBooked = [];
  for (const p of pipelines) {
    const opps = await ghl
      .searchOpportunities({ pipelineId: p.id, status: "open" })
      .catch(() => []);
    for (const o of opps) {
      const stage = (o.pipelineStageName || "").toLowerCase();
      const updated = new Date(o.updatedAt || o.dateAdded);
      if (updated < new Date(fromIso) || updated > new Date(toIso)) continue;
      if (
        stage.includes("appointment booked") ||
        stage.includes("over phone sale")
      ) {
        const dispatcher =
          [...byDispatcher.values()].find((d) => d.ghlUserId === o.assignedTo) ||
          { name: "—" };
        if (dispatcher.bookings != null) dispatcher.bookings += 1;
        appointmentsBooked.push({
          leadName: o.contact?.name || o.name || "(unnamed)",
          time: fmtTime(updated),
          dispatcher: dispatcher.name,
          stage: o.pipelineStageName,
        });
      }
    }
  }

  // New-lead response time
  const newLeads = await ghl
    .searchContacts({ from: fromIso, to: toIso, limit: 100 })
    .catch(() => []);
  const responseTimeAlerts = [];
  for (const c of newLeads) {
    const created = new Date(c.dateAdded);
    // Find earliest outbound call to this contact
    let firstCallAt = null;
    let firstCallBy = null;
    const conv = conversations.find((cv) => cv.contactId === c.id);
    if (conv) {
      const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
      const calls = msgs
        .filter((m) => (m.type || "").toUpperCase() === "CALL")
        .filter((m) => (m.direction || "").toLowerCase() === "outbound");
      if (calls.length) {
        calls.sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
        firstCallAt = new Date(calls[0].dateAdded);
        const userId = calls[0].userId;
        firstCallBy =
          [...byDispatcher.values()].find((d) => d.ghlUserId === userId)?.name;
      }
    }
    const delayMinutes = firstCallAt
      ? (firstCallAt - created) / 60000
      : (new Date() - created) / 60000;
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

  // Cross-reference low activity + low calls
  if (hubstaffByUser) {
    for (const [, slot] of hubstaffByUser) {
      const emp = slot.employee;
      const dispatcher = byDispatcher.get(emp.name);
      if (!dispatcher) continue;
      // The Hubstaff section's lowActivityFlags array gets mutated by the
      // caller after both sections are built — but we can also pre-tag
      // hours where calls < 2 here. Simple version: count how many hours
      // have <= 1 call.
    }
  }

  return {
    byDispatcher: [...byDispatcher.values()].map((d) => ({
      name: d.name,
      total: d.total,
      under25: d.under25,
      over25: d.over25,
      bookings: d.bookings,
    })),
    responseTimeAlerts,
    appointmentsBooked,
    _callsByDispatcherByHour: byDispatcher, // for cross-reference
  };
}

// ---------- Top-level orchestrators ----------

export async function runMorningReport() {
  const generatedAt = now();
  const { from, to } = morningWindow(generatedAt);

  const hub = await buildHubstaffSection({ from, to, includeTotals: false });
  const dispatch = await buildDispatcherSection({
    from,
    to,
    hubstaffByUser: hub._byUser,
  });

  // Cross-reference low activity AND low calls
  for (const f of hub.lowActivityFlags) {
    const dispatcher = dispatch._callsByDispatcherByHour.get(f.employee);
    if (dispatcher) {
      const calls = dispatcher.callsByHour.get(f.hour) || 0;
      if (calls <= 1) f.alsoLowCalls = true;
    }
  }

  const html = renderEmail({
    title: "Local AC — Morning Snapshot",
    generatedAt,
    sections: [
      renderHubstaffSection(hub),
      renderDispatcherSection(dispatch),
    ],
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
  const dispatch = await buildDispatcherSection({
    from,
    to,
    hubstaffByUser: hub._byUser,
  });

  for (const f of hub.lowActivityFlags) {
    const dispatcher = dispatch._callsByDispatcherByHour.get(f.employee);
    if (dispatcher) {
      const calls = dispatcher.callsByHour.get(f.hour) || 0;
      if (calls <= 1) f.alsoLowCalls = true;
    }
  }

  const html = renderEmail({
    title: "Local AC — Full Day Summary",
    generatedAt,
    sections: [
      renderHubstaffSection(hub),
      renderDispatcherSection(dispatch),
    ],
  });

  await sendMail({
    subject: `Local AC — Full Day Summary (${generatedAt.toFormat("LLL d")})`,
    html,
  });
}
