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

  return router;
}
