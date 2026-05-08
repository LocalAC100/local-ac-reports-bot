// Debug router — admin-only endpoints that dump RAW Hubstaff and GHL API
// responses so we can verify that the data we *collect* is correct before
// we trust the data we *display*. Put here (not in dashboard.js) to avoid
// merging conflicts with the website chat that owns dashboard.js.
//
// Mount in server.js: app.use(buildDebugRouter());
//
// Endpoints:
//   GET /admin/debug/raw                          — today, all employees
//   GET /admin/debug/raw?date=YYYY-MM-DD          — specific date (ET)
//   GET /admin/debug/raw?employee=Ellie           — single employee filter
//   GET /admin/debug/hubstaff/fields              — show every field name
//                                                   present in daily/activity
//                                                   rows so we can identify
//                                                   which one is the % field
import express from "express";
import { requireAdmin } from "./auth.js";
import * as ghl from "./ghl.js";

export function buildDebugRouter() {
  const router = express.Router();

  router.get("/admin/debug/raw", requireAdmin, async (req, res) => {
    try {
      const { DateTime } = await import("luxon");
      const hubstaff = await import("./hubstaff.js");
      const { EMPLOYEES } = await import("./employees.js");

      const TZ = "America/New_York";
      const dateStr =
        req.query.date || DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
      const employeeFilter = req.query.employee || null;

      const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
      const dayEnd = dayStart.endOf("day");
      const fromIso = dayStart.toUTC().toISO();
      const toIso = dayEnd.toUTC().toISO();

      const orgUsers = await hubstaff.listOrgUsers().catch(() => []);
      const userByEmail = new Map(
        orgUsers.map((u) => [(u.email || "").toLowerCase(), u])
      );
      const matched = EMPLOYEES.map((e) => {
        const hu = userByEmail.get((e.hubstaffEmail || "").toLowerCase());
        return {
          name: e.name,
          role: e.role,
          hubstaffEmail: e.hubstaffEmail,
          hubstaffUserId: hu?.id ?? null,
          ghlEmail: e.ghlEmail,
        };
      }).filter((e) => !employeeFilter || e.name === employeeFilter);

      const userIds = matched.map((m) => m.hubstaffUserId).filter(Boolean);

      const [activities, daily, timesheets, pipelines, conversations] =
        await Promise.all([
          hubstaff
            .getActivities({ from: fromIso, to: toIso, userIds })
            .catch((e) => ({ error: e?.message })),
          hubstaff
            .getDailyActivities({ date: dateStr, userIds })
            .catch((e) => ({ error: e?.message })),
          hubstaff
            .getTimesheets({ from: fromIso, to: toIso, userIds })
            .catch((e) => ({ error: e?.message })),
          ghl.listPipelines().catch((e) => ({ error: e?.message })),
          ghl
            .listActiveConversations({ from: fromIso, to: toIso })
            .catch((e) => ({ error: e?.message })),
        ]);

      // Group hubstaff activities by user so it's readable
      const activitiesByUser = {};
      if (Array.isArray(activities)) {
        for (const a of activities) {
          const u = matched.find((m) => m.hubstaffUserId === a.user_id);
          const key = u ? u.name : `user_${a.user_id}`;
          (activitiesByUser[key] ||= []).push({
            starts_at: a.starts_at || a.time_slot,
            tracked: a.tracked,
            keyboard: a.keyboard,
            mouse: a.mouse,
            overall: a.overall,
            overall_activity: a.overall_activity,
            activity: a.activity,
          });
        }
      }

      const dailyByUser = {};
      if (Array.isArray(daily)) {
        for (const d of daily) {
          const u = matched.find((m) => m.hubstaffUserId === d.user_id);
          const key = u ? u.name : `user_${d.user_id}`;
          dailyByUser[key] = d;
        }
      }

      const timesheetsByUser = {};
      if (Array.isArray(timesheets)) {
        for (const t of timesheets) {
          const u = matched.find((m) => m.hubstaffUserId === t.user_id);
          const key = u ? u.name : `user_${t.user_id}`;
          (timesheetsByUser[key] ||= []).push({
            starts_at: t.starts_at,
            stops_at: t.stops_at || t.ends_at,
            duration: t.duration || t.tracked,
            project_id: t.project_id,
            note: t.note,
          });
        }
      }

      const convCount = Array.isArray(conversations)
        ? conversations.length
        : null;
      const convUniqueIds = Array.isArray(conversations)
        ? new Set(conversations.map((c) => c.id)).size
        : null;

      res.json({
        ok: true,
        date: dateStr,
        timezone: TZ,
        windowUTC: { from: fromIso, to: toIso },
        employees: matched,
        hubstaff: {
          daily: {
            count: Array.isArray(daily) ? daily.length : null,
            byUser: dailyByUser,
            sampleRowKeys: Array.isArray(daily) && daily[0]
              ? Object.keys(daily[0])
              : null,
          },
          activities: {
            count: Array.isArray(activities) ? activities.length : null,
            byUser: activitiesByUser,
            sampleRowKeys:
              Array.isArray(activities) && activities[0]
                ? Object.keys(activities[0])
                : null,
          },
          timesheets: {
            count: Array.isArray(timesheets) ? timesheets.length : null,
            byUser: timesheetsByUser,
            sampleRowKeys:
              Array.isArray(timesheets) && timesheets[0]
                ? Object.keys(timesheets[0])
                : null,
          },
        },
        ghl: {
          pipelines: Array.isArray(pipelines)
            ? pipelines.map((p) => ({
                id: p.id,
                name: p.name,
                stageCount: (p.stages || []).length,
              }))
            : pipelines,
          conversationCount: convCount,
          conversationUniqueCount: convUniqueIds,
          paginationDuplicates:
            convCount != null && convUniqueIds != null
              ? convCount - convUniqueIds
              : null,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
    }
  });

  // /admin/debug/dispatcher-calls — count outbound calls/SMS for each
  // dispatcher today, computed the SAME way reports.js does. Used to verify
  // the headline numbers in the evening report against raw GHL data.
  // Returns per-dispatcher breakdown + totals matching report's section 2.
  router.get("/admin/debug/dispatcher-calls", requireAdmin, async (req, res) => {
    try {
      const { DateTime } = await import("luxon");
      const { EMPLOYEES, isDispatcher } = await import("./employees.js");

      const TZ = "America/New_York";
      const dateStr =
        req.query.date || DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
      const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
      const dayEnd = dayStart.endOf("day");
      const fromIso = dayStart.toUTC().toISO();
      const toIso = dayEnd.toUTC().toISO();

      const REPORTED_PIPELINE_NAMES = ["Orlando Pipeline", "Tampa Pipeline"];

      const [pipelines, allConversations, ghlUsers] = await Promise.all([
        ghl.listPipelines().catch(() => []),
        ghl.listActiveConversations({ from: fromIso, to: toIso }).catch(() => []),
        ghl.listUsers().catch(() => []),
      ]);

      const reportedPipelines = pipelines.filter((p) =>
        REPORTED_PIPELINE_NAMES.includes(p.name)
      );

      // Build contactStage map (same as reports.js)
      const contactStage = new Map();
      for (const p of reportedPipelines) {
        for (const status of ["open", "won", "lost", "abandoned"]) {
          const opps = await ghl
            .searchOpportunities({ pipelineId: p.id, status, limit: 100 })
            .catch(() => []);
          for (const o of opps) {
            const cid = o.contactId || o.contact?.id;
            if (cid) contactStage.set(cid, { pipeline: p.name });
          }
        }
      }

      const orlandoConvs = allConversations.filter(
        (c) => c.contactId && contactStage.has(c.contactId)
      );

      const dispatchers = EMPLOYEES.filter(isDispatcher);
      const ghlByEmail = new Map(
        ghlUsers.map((u) => [(u.email || "").toLowerCase(), u])
      );
      const byDispatcher = {};
      for (const e of dispatchers) {
        const ghlUser = ghlByEmail.get(
          (e.ghlEmail || e.hubstaffEmail || "").toLowerCase()
        );
        byDispatcher[e.name] = {
          name: e.name,
          ghlUserId: ghlUser?.id || null,
          ghlEmail: e.ghlEmail,
          real: 0,
          voicemail: 0,
          attempt: 0,
          sms: 0,
          unknownUserCalls: 0, // calls with no matching dispatcher
        };
      }
      // Sentinel for unmatched
      byDispatcher.__unknown = { name: "(unknown)", real: 0, voicemail: 0, attempt: 0, sms: 0 };

      let totalOutboundCalls = 0;
      let totalOutboundSms = 0;
      let convsWalked = 0;
      const sampleEvents = [];

      for (const conv of orlandoConvs) {
        const msgs = await ghl
          .getConversationMessages(conv.id)
          .catch(() => []);
        convsWalked++;
        for (const m of msgs) {
          const dir = String(m.direction ?? "").toLowerCase();
          if (dir !== "outbound") continue;
          const dt = DateTime.fromISO(
            m.dateAdded || m.createdAt || ""
          ).setZone(TZ);
          if (!dt.isValid) continue;
          if (dt < dayStart || dt > dayEnd) continue;

          const userId = m.userId || m.user || m.createdBy;
          const isCall =
            m.type === 1 ||
            m.messageType === "TYPE_CALL" ||
            /CALL/i.test(String(m.type ?? ""));
          const isSms = m.type === 2 || m.messageType === "TYPE_SMS";

          let target = null;
          for (const k of Object.keys(byDispatcher)) {
            if (byDispatcher[k].ghlUserId === userId) {
              target = byDispatcher[k];
              break;
            }
          }

          if (isCall) {
            totalOutboundCalls++;
            const dur = Number(
              m.meta?.call?.duration ?? m.callDuration ?? m.duration ?? 0
            );
            const status = String(m.meta?.call?.status || "").toLowerCase();
            let bk = "attempt";
            if (status === "voicemail" || (dur >= 5 && dur < 30)) bk = "voicemail";
            else if (dur >= 30) bk = "real";

            if (target) {
              target[bk] += 1;
            } else {
              byDispatcher.__unknown[bk] += 1;
              byDispatcher.__unknown.unknownUserCalls =
                (byDispatcher.__unknown.unknownUserCalls || 0) + 1;
            }
            if (sampleEvents.length < 8) {
              sampleEvents.push({
                time: dt.toFormat("h:mm a"),
                kind: bk,
                durSec: dur,
                status,
                userId,
                dispatcher: target?.name || "(unknown)",
                contactId: conv.contactId,
              });
            }
          } else if (isSms) {
            if (!userId) continue; // skip workflow auto-texts
            totalOutboundSms++;
            if (target) target.sms += 1;
            else byDispatcher.__unknown.sms += 1;
          }
        }
      }

      const totals = { real: 0, voicemail: 0, attempt: 0, sms: 0 };
      for (const k of Object.keys(byDispatcher)) {
        const d = byDispatcher[k];
        totals.real += d.real;
        totals.voicemail += d.voicemail;
        totals.attempt += d.attempt;
        totals.sms += d.sms;
      }

      res.json({
        ok: true,
        date: dateStr,
        timezone: TZ,
        windowUTC: { from: fromIso, to: toIso },
        conversations: {
          totalActive: allConversations.length,
          orlandoFiltered: orlandoConvs.length,
          walked: convsWalked,
        },
        totals,
        totalOutboundCallsRaw: totalOutboundCalls,
        totalOutboundSmsRaw: totalOutboundSms,
        byDispatcher,
        sampleEvents,
        reportedPipelines: reportedPipelines.map((p) => p.name),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
    }
  });

  return router;
}
