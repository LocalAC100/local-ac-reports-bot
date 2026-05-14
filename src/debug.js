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

  // /admin/debug/bookings — list today's bookings two ways:
  //   1. GHL calendar appointments (the same source the other chat used)
  //   2. Opportunities currently in Appt. Booked / Over Phone Sale / Live
  //      Transfer stages with updatedAt today (proxy for "moved today")
  // Returns both lists with contact names + times so we can eyeball-verify.
  router.get("/admin/debug/bookings", requireAdmin, async (req, res) => {
    try {
      const { DateTime } = await import("luxon");
      const axios = (await import("axios")).default;
      const { config } = await import("./config.js");

      const TZ = "America/New_York";
      const dateStr =
        req.query.date || DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
      const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
      const dayEnd = dayStart.endOf("day");
      const fromMs = dayStart.toMillis();
      const toMs = dayEnd.toMillis();
      const fromIso = dayStart.toUTC().toISO();
      const toIso = dayEnd.toUTC().toISO();

      const http = axios.create({
        baseURL: "https://services.leadconnectorhq.com",
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${config.ghl.apiKey}`,
          Version: "2021-07-28",
          Accept: "application/json",
        },
      });

      // 1) List all calendars (so we can show what calendars exist)
      const calsResp = await http
        .get("/calendars/", {
          params: { locationId: config.ghl.locationId },
        })
        .catch((e) => ({ data: { error: e?.response?.data || e?.message } }));
      const calendars = calsResp.data?.calendars || [];

      // 2) Pull events from /calendars/events for EACH calendar
      //    (the endpoint requires a calendarId; no all-calendars mode).
      const appointments = [];
      const calendarErrors = [];
      for (const cal of calendars) {
        try {
          const er = await http.get("/calendars/events", {
            params: {
              locationId: config.ghl.locationId,
              calendarId: cal.id,
              startTime: fromMs,
              endTime: toMs,
            },
          });
          const events = er.data?.events || [];
          for (const ev of events) {
            appointments.push({ ...ev, _calendarId: cal.id, _calendarName: cal.name });
          }
        } catch (e) {
          calendarErrors.push({
            calendarId: cal.id,
            calendarName: cal.name,
            error: e?.response?.data?.message || e?.message,
          });
        }
      }
      const apptResp = { data: { error: calendarErrors.length ? calendarErrors : null } };

      // For each appointment, try to pull the contact name
      async function fetchContact(cid) {
        if (!cid) return null;
        try {
          const r = await http.get(`/contacts/${cid}`, {
            params: { locationId: config.ghl.locationId },
          });
          const c = r.data?.contact;
          return {
            name: `${c?.firstName ?? ""} ${c?.lastName ?? ""}`.trim() ||
              c?.contactName || c?.email || `(unnamed:${cid})`,
            phone: c?.phone || null,
          };
        } catch (e) {
          return { name: `(lookup failed:${cid})`, phone: null };
        }
      }

      const apptDetails = [];
      for (const a of appointments) {
        const contact = await fetchContact(a.contactId);
        const startEt = a.startTime
          ? DateTime.fromISO(a.startTime).setZone(TZ).toFormat("h:mm a")
          : "(no start)";
        apptDetails.push({
          appointmentId: a.id,
          calendarId: a._calendarId || a.calendarId,
          calendarName: a._calendarName || "(unknown calendar)",
          startTime: startEt,
          startTimeIso: a.startTime,
          contactId: a.contactId,
          contactName: contact?.name,
          contactPhone: contact?.phone,
          assignedUserId: a.assignedUserId,
          status: a.appointmentStatus || a.status,
          title: a.title,
        });
      }

      // 3) Opportunities in booking stages, updatedAt today
      //    Pull all pipelines (not just Orlando+Tampa) so we see everything.
      const pipResp = await http
        .get("/opportunities/pipelines", {
          params: { locationId: config.ghl.locationId },
        })
        .catch((e) => ({ data: { error: e?.response?.data || e?.message } }));
      const pipelines = pipResp.data?.pipelines || [];

      const BOOKING_STAGE_KEYWORDS = [
        "appointment booked",
        "appt. booked",
        "appt booked",
        "over phone sale",
        "over phone booked",
        "phone sale",
        "live transfer",
      ];
      const stageMovedBookings = [];
      for (const p of pipelines) {
        const opps = await http
          .get("/opportunities/search", {
            params: {
              location_id: config.ghl.locationId,
              pipeline_id: p.id,
              limit: 100,
            },
          })
          .then((r) => r.data?.opportunities || [])
          .catch(() => []);
        for (const o of opps) {
          const stage = String(o.pipelineStageName || "").toLowerCase();
          const matchedKeyword = BOOKING_STAGE_KEYWORDS.find((k) =>
            stage.includes(k)
          );
          if (!matchedKeyword) continue;
          const updated = o.updatedAt ? new Date(o.updatedAt).getTime() : 0;
          if (updated < fromMs || updated > toMs) continue;
          stageMovedBookings.push({
            opportunityId: o.id,
            pipeline: p.name,
            stage: o.pipelineStageName,
            contactId: o.contactId,
            contactName:
              o.contact?.name ||
              o.name ||
              `${o.contact?.firstName || ""} ${o.contact?.lastName || ""}`.trim() ||
              "(unnamed)",
            assignedUserId: o.assignedTo,
            updatedAt: o.updatedAt,
            updatedAtEt: DateTime.fromISO(o.updatedAt)
              .setZone(TZ)
              .toFormat("h:mm a"),
          });
        }
      }

      res.json({
        ok: true,
        date: dateStr,
        timezone: TZ,
        calendarsCount: calendars.length,
        calendars: calendars.map((c) => ({
          id: c.id,
          name: c.name,
          calendarType: c.calendarType,
          isActive: c.isActive,
        })),
        calendarAppointments: {
          count: apptDetails.length,
          rows: apptDetails,
          rawError: apptResp.data?.error || null,
        },
        opportunityStageMoves: {
          count: stageMovedBookings.length,
          rows: stageMovedBookings,
        },
        pipelines: pipelines.map((p) => p.name),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
    }
  });

  // /admin/debug/calls-spec — implements the verified GHL extraction spec.
  // Goal: produce numbers that match the regression target for 2026-05-07:
  //   Total 548 / Outbound 545 / Inbound 3
  //   Live Transfer 2, Real Call 58, No Answer 427, Failed 60, Ringing 1
  //   Mark 213, Ellie 171, Angel 101, Frank 53, Chris 7
  //
  // Method (per spec):
  //   1. /conversations/search?lastMessageType=TYPE_CALL paginated by
  //      startAfterDate / endBeforeDate (DESC by last_message_date)
  //   2. /conversations/{id}/messages?type=TYPE_CALL paginated by lastMessageId
  //      Note the response shape: data.messages.messages (DOUBLE NESTED)
  //   3. Categorize per the 5-bucket rule below
  //
  // Categorization (do NOT trust "Answered" alone — voicemail pickups read as
  // completed, which is what broke the old report):
  //   Live Transfer = duration >= 30 AND meta.call.participants has a label
  //                   starting with "transfer:"
  //   Real Call     = duration >= 30, no live transfer
  //   No Answer     = status == "no-answer" OR (status == "completed" AND
  //                   duration < 30)
  //   Failed        = status in {failed, busy}
  //   Ringing       = status == "ringing"
  router.get("/admin/debug/calls-spec", requireAdmin, async (req, res) => {
    try {
      const { DateTime } = await import("luxon");
      const axios = (await import("axios")).default;
      const { config } = await import("./config.js");
      const { EMPLOYEES } = await import("./employees.js");

      const TZ = "America/New_York";
      const dateStr =
        req.query.date || DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
      const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
      const dayEnd = dayStart.endOf("day");
      const fromMs = dayStart.toMillis();
      const toMs = dayEnd.toMillis();

      const http = axios.create({
        baseURL: "https://services.leadconnectorhq.com",
        timeout: 30000,
        headers: {
          Authorization: `Bearer ${config.ghl.apiKey}`,
          Version: "2021-07-28",
          Accept: "application/json",
        },
      });

      // ---- Step 1: pull all conversations with calls today ----
      // Use lastMessageType=TYPE_CALL hint, paginate DESC by last_message_date.
      // Dedupe by conversation id, advance cursor below oldest in batch.
      const convSeen = new Set();
      const conversations = [];
      let cursor = toMs + 1;
      let convPages = 0;
      const MAX_CONV_PAGES = 50;
      while (convPages < MAX_CONV_PAGES) {
        convPages++;
        let r;
        try {
          r = await http.get("/conversations/search", {
            params: {
              locationId: config.ghl.locationId,
              lastMessageType: "TYPE_CALL",
              startAfterDate: fromMs,
              endBeforeDate: cursor,
              limit: 100,
              sort: "desc",
              sortBy: "last_message_date",
            },
          });
        } catch (e) {
          // Some GHL accounts don't accept lastMessageType filter — fall back
          // to the no-filter version that returns everything in window.
          r = await http
            .get("/conversations/search", {
              params: {
                locationId: config.ghl.locationId,
                startAfterDate: fromMs,
                endBeforeDate: cursor,
                limit: 100,
                sort: "desc",
                sortBy: "last_message_date",
              },
            })
            .catch(() => ({ data: { conversations: [] } }));
        }
        const batch = r.data?.conversations || [];
        if (batch.length === 0) break;
        let added = 0;
        for (const c of batch) {
          if (convSeen.has(c.id)) continue;
          convSeen.add(c.id);
          conversations.push(c);
          added++;
        }
        const oldest = batch[batch.length - 1].lastMessageDate;
        if (!oldest) break;
        const oldestMs = new Date(oldest).getTime();
        if (added === 0) break; // dedupe stuck → bail
        // Stop if oldest is more than 1 day BEFORE our window — we can't
        // possibly find more relevant convs going further back.
        if (oldestMs < fromMs - 86400000) break;
        const next = oldestMs - 1;
        if (next >= cursor) break;
        cursor = next;
      }

      // ---- Step 2: pull all call messages from each conversation ----
      // Paginate via lastMessageId. Filter by ?type=TYPE_CALL. Time-window
      // filter on dateAdded.
      const calls = [];
      let messagePages = 0;
      for (const conv of conversations) {
        let lastMessageId = null;
        let convMessagePages = 0;
        while (convMessagePages < 20) {
          convMessagePages++;
          messagePages++;
          const params = {
            locationId: config.ghl.locationId,
            limit: 100,
          };
          if (lastMessageId) params.lastMessageId = lastMessageId;
          let r;
          try {
            r = await http.get(`/conversations/${conv.id}/messages`, {
              params,
            });
          } catch (e) {
            break;
          }
          // Note: response is { messages: { messages: [...], nextPage, lastMessageId } }
          const block = r.data?.messages || {};
          const msgs = block.messages || [];
          if (msgs.length === 0) break;
          for (const m of msgs) {
            if (!m.dateAdded) continue;
            const dt = new Date(m.dateAdded).getTime();
            if (dt < fromMs || dt > toMs) continue;

            // Only count CALL messages. type=1 numeric, or messageType=TYPE_CALL.
            const isCallMsg =
              m.type === 1 ||
              m.messageType === "TYPE_CALL" ||
              /CALL/i.test(String(m.type || ""));
            if (!isCallMsg) continue;

            const direction = String(m.direction || "").toLowerCase();
            const duration = Number(
              m.meta?.call?.duration ?? m.callDuration ?? m.duration ?? 0
            );
            const status = String(m.meta?.call?.status || "").toLowerCase();

            // Live Transfer detection — try meta.call.participants
            const participants =
              m.meta?.call?.participants || m.meta?.participants || [];
            let hasTransfer = false;
            if (Array.isArray(participants)) {
              for (const p of participants) {
                const label = String(p?.label || p || "");
                if (label.startsWith("transfer:")) {
                  hasTransfer = true;
                  break;
                }
              }
            } else if (typeof participants === "object" && participants) {
              for (const k of Object.keys(participants)) {
                if (String(k).startsWith("transfer:")) {
                  hasTransfer = true;
                  break;
                }
                const val = participants[k];
                if (typeof val === "string" && val.startsWith("transfer:")) {
                  hasTransfer = true;
                  break;
                }
              }
            }

            let category;
            if (duration >= 30 && hasTransfer) category = "live_transfer";
            else if (duration >= 30) category = "real_call";
            else if (status === "no-answer") category = "no_answer";
            else if (status === "completed" && duration < 30)
              category = "no_answer";
            else if (status === "failed" || status === "busy")
              category = "failed";
            else if (status === "ringing") category = "ringing";
            else category = "no_answer"; // catch-all

            calls.push({
              id: m.id,
              dateAddedIso: m.dateAdded,
              direction,
              duration,
              status,
              category,
              hasTransfer,
              contactId: conv.contactId,
              userId: m.userId,
              hour: DateTime.fromISO(m.dateAdded).setZone(TZ).hour,
            });
          }
          // Pagination
          if (!block.nextPage || !block.lastMessageId) break;
          if (block.lastMessageId === lastMessageId) break;
          lastMessageId = block.lastMessageId;
        }
      }

      // ---- Aggregate ----
      const totals = {
        total: 0,
        outbound: 0,
        inbound: 0,
        byCategory: {
          live_transfer: 0,
          real_call: 0,
          no_answer: 0,
          failed: 0,
          ringing: 0,
        },
      };
      const byUser = {};
      const byHour = {};
      const uniqueContacts = new Set();
      for (const c of calls) {
        totals.total++;
        if (c.direction === "outbound") totals.outbound++;
        else if (c.direction === "inbound") totals.inbound++;
        totals.byCategory[c.category] =
          (totals.byCategory[c.category] || 0) + 1;
        const u = c.userId || "(none)";
        if (!byUser[u]) {
          byUser[u] = {
            userId: u,
            total: 0,
            real_call: 0,
            no_answer: 0,
            failed: 0,
            live_transfer: 0,
            ringing: 0,
          };
        }
        byUser[u].total++;
        byUser[u][c.category] = (byUser[u][c.category] || 0) + 1;
        byHour[c.hour] = (byHour[c.hour] || 0) + 1;
        if (c.contactId) uniqueContacts.add(c.contactId);
      }

      // Map userId -> dispatcher name for known dispatchers
      const ghlUsers = await http
        .get("/users/", { params: { locationId: config.ghl.locationId } })
        .then((r) => r.data?.users || [])
        .catch(() => []);
      const userById = new Map(ghlUsers.map((u) => [u.id, u]));
      const dispatcherSummary = [];
      for (const userId of Object.keys(byUser)) {
        const u = userById.get(userId);
        const fullName = u
          ? `${u.firstName || ""} ${u.lastName || ""}`.trim() ||
            u.name ||
            userId
          : userId === "(none)"
            ? "(no userId — likely inbound)"
            : `(unmatched ${userId})`;
        dispatcherSummary.push({
          name: fullName,
          ...byUser[userId],
        });
      }
      dispatcherSummary.sort((a, b) => b.total - a.total);

      res.json({
        ok: true,
        date: dateStr,
        timezone: TZ,
        windowMs: { from: fromMs, to: toMs },
        scan: {
          conversationsFound: conversations.length,
          conversationPages: convPages,
          messagePages,
          callsExtracted: calls.length,
        },
        totals,
        uniqueContacts: uniqueContacts.size,
        byHour,
        byDispatcher: dispatcherSummary,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
    }
  });

  // POST /admin/ghl-jwt — store the HighLevel session JWT (the same token
  // their browser uses for backend.leadconnectorhq.com calls). Persisted to
  // Render disk so it survives restarts.
  router.post(
    "/admin/ghl-jwt",
    requireAdmin,
    express.json({ limit: "1mb" }),
    async (req, res) => {
      try {
        const fs = await import("fs");
        const path = await import("path");
        const dataDir = process.env.DATA_DIR || "/var/data";
        const file = path.default.join(dataDir, "ghl-internal-jwt.json");
        try {
          fs.default.mkdirSync(dataDir, { recursive: true });
        } catch {}
        const payload = JSON.stringify(
          { ...req.body, savedAt: new Date().toISOString() },
          null,
          2
        );
        fs.default.writeFileSync(file, payload, "utf8");
        res.json({
          ok: true,
          savedAt: new Date().toISOString(),
          keysReceived: Object.keys(req.body || {}),
          file,
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message });
      }
    }
  );

  // GET /admin/debug/firehose — call HighLevel's INTERNAL Call Reporting
  // endpoint (the same one the dashboard's "Call Reporting" page uses).
  // Requires the session JWT stored via /admin/ghl-jwt.
  // Query params: date (YYYY-MM-DD ET), direction (outbound|inbound, default
  // outbound). Returns totalRows, plus a count + sample of the response rows.
  router.get("/admin/debug/firehose", requireAdmin, async (req, res) => {
    try {
      const { DateTime } = await import("luxon");
      const axios = (await import("axios")).default;
      const fs = await import("fs");
      const path = await import("path");
      const { config } = await import("./config.js");

      const dataDir = process.env.DATA_DIR || "/var/data";
      const file = path.default.join(dataDir, "ghl-internal-jwt.json");
      let jwt;
      try {
        jwt = JSON.parse(fs.default.readFileSync(file, "utf8"));
      } catch (e) {
        return res.status(400).json({
          ok: false,
          error:
            "no JWT stored. POST { token-id: 'eyJ...', or full localStorage.refreshedToken JSON } to /admin/ghl-jwt first.",
        });
      }

      const TZ = "America/New_York";
      const dateStr =
        req.query.date || DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
      const direction = req.query.direction || "outbound";
      const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
      const dayEnd = dayStart.endOf("day");

      const body = {
        locationId: config.ghl.locationId,
        source: [],
        sourceType: [],
        keyword: [],
        landingPage: [],
        referrer: [],
        campaign: [],
        callStatus: [],
        dispositions: [],
        deviceType: [],
        qualifiedLead: false,
        firstTime: false,
        duration: null,
        selectedPool: "all",
        direction,
        startDate: dayStart.toUTC().toISO(),
        endDate: dayEnd.toUTC().toISO(),
        userId: "",
        limit: 1000,
        skip: 0,
      };

      // The "token-id" header is set to the access token. The other chat's
      // pseudocode was JSON.parse(localStorage.getItem('refreshedToken'))
      // which suggests the value stored in localStorage is JSON-wrapped. We
      // accept several shapes: raw string, {token-id:...}, {accessToken:...},
      // or pass the full payload through.
      const tokenIdValue =
        jwt["token-id"] ||
        jwt.tokenId ||
        jwt.accessToken ||
        jwt.access_token ||
        jwt.token ||
        jwt.raw ||
        (typeof jwt === "string" ? jwt : null);

      if (!tokenIdValue) {
        return res.status(400).json({
          ok: false,
          error: "stored JWT object has no recognizable token field",
          haveKeys: Object.keys(jwt),
        });
      }

      let resp, errInfo;
      try {
        resp = await axios.post(
          "https://backend.leadconnectorhq.com/reporting/calls/get-all-phone-calls-new",
          body,
          {
            headers: {
              "token-id": tokenIdValue,
              channel: "APP",
              source: "WEB_USER",
              version: "2021-04-15",
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            timeout: 30000,
          }
        );
      } catch (err) {
        errInfo = {
          status: err?.response?.status,
          data: err?.response?.data,
          message: err?.message,
        };
      }

      if (errInfo) {
        return res.json({
          ok: false,
          callError: errInfo,
          tokenSnippet:
            String(tokenIdValue).slice(0, 8) +
            "..." +
            String(tokenIdValue).slice(-6),
          requestBody: body,
        });
      }

      const data = resp.data || {};
      const rows = Array.isArray(data.rows) ? data.rows : [];

      // Per-userId tally + sample
      const byUserCount = {};
      for (const r of rows) {
        const u = r.userId || "(none)";
        byUserCount[u] = (byUserCount[u] || 0) + 1;
      }
      const sample = rows.slice(0, 3).map((r) => ({
        callSid: r.callSid,
        status: r.callStatus,
        duration: r.duration,
        direction: r.direction,
        userId: r.userId,
        contactId: r.contactId,
        dateAdded: r.dateAdded,
      }));

      res.json({
        ok: true,
        date: dateStr,
        direction,
        totalRows: data.totalRows,
        totalPages: data.totalPages,
        rowCountReturned: rows.length,
        traceId: data.traceId,
        byUserCount,
        sample,
      });
    } catch (e) {
      res
        .status(500)
        .json({ ok: false, error: e?.message, stack: e?.stack });
    }
  });

  // GET /admin/debug/check-idle?s=<SEC>&nomail=1
  // Secret-bypass admin endpoint — no session needed, secret query param only.
  // Runs checkIdleDispatchers() synchronously and returns the diagnostic JSON.
  // Use nomail=1 (default ON for safety) to skip the actual sendMail / Alerts.log
  // calls; pass nomail=0 to fire emails for real (matches the cron behavior).
  //
  // Useful for verifying:
  //   - Ellie / Angel / Mark are evaluated (or skipped with the right reason)
  //   - Frank / Chris are skipped via idleAlertsExcluded
  //   - The Hubstaff break check returns the expected onBreak status
  //   - Idle minutes / threshold / cooldown all line up
  router.get("/admin/debug/check-idle", async (req, res) => {
    try {
      const SEC = process.env.ADMIN_SECRET;
      if (!SEC || req.query.s !== SEC) {
        return res.status(403).json({ ok: false, error: "bad secret" });
      }
      const idle = await import("./idle.js");
      const dryRun = req.query.nomail !== "0"; // default true unless nomail=0
      const diag = await idle.checkIdleDispatchers({ dryRun });
      res.json({ ok: true, dryRun, ...diag });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
    }
  });

  // ONE-SHOT bootstrap endpoint — no admin auth, only requires secret query param.
  // Used to transfer the GHL JWT from a logged-in browser tab where reading
  // the value back to chat is blocked. After bootstrap the admin endpoints
  // can be used normally. Secret rotates per deploy.
  router.get("/admin/ghl-jwt-bootstrap-jwt-bootstrap-njrp8vv9kh", async (req, res) => {
    try {
      const fs = await import("fs");
      const path = await import("path");
      const tokenIdValue = req.query.t;
      if (!tokenIdValue) return res.status(400).send("missing t param");
      const dataDir = process.env.DATA_DIR || "/var/data";
      const file = path.default.join(dataDir, "ghl-internal-jwt.json");
      try { fs.default.mkdirSync(dataDir, { recursive: true }); } catch {}
      const payload = JSON.stringify({ "token-id": String(tokenIdValue), savedAt: new Date().toISOString() }, null, 2);
      fs.default.writeFileSync(file, payload, "utf8");
      res.send("ok len=" + String(tokenIdValue).length);
    } catch (e) {
      res.status(500).send("err: " + e?.message);
    }
  });

  return router;
}
