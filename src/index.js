// Entry point. Boots the HTTP server (for the GHL webhook + healthz) and
// schedules the daily reports via node-cron in the configured timezone.
//
// SCHEDULE (v20.2, locked May 14 2026):
//   12:00 PM ET     Morning Snapshot — today midnight to noon
//    9:00 PM ET     Evening Snapshot — today (full-day-to-date)
//    7:00 AM ET     Full Day Summary of YESTERDAY (so Tuesday 7 AM = Monday recap)
//    2:00 AM ET     Firehose backfill for yesterday (feeds the 7 AM evening report)
//    8:15 AM ET     Morning catch-up — overnight leads still uncontacted (v20.2)
//   */15 6-22 ET    Firehose backfill for today (every 15 min during business hours)
//   */5  8-20 ET    Dispatcher-idle check — 15-min threshold, Hubstaff-break-aware
//   */5  *   *      JWT refresh (Firebase id_token expires in ~1hr; refresh keeps backfill alive)
//
// On boot: re-arm any pending lead alerts from /var/data/pending-alerts.json so
// Render restarts don't lose mid-flight 10-min escalation timers.
import cron from "node-cron";
import { config } from "./config.js";
import { buildServer } from "./server.js";
import { runMorningReport, runEveningReport } from "./reports.js";
import { backfillDate, refreshStoredJwt } from "./firehose-backfill.js";
import { checkIdleDispatchers } from "./idle.js";
import { initAlerts, runMorningCatchUp } from "./alerts.js";

const app = buildServer();
app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} tz=${config.timezone}`);
  try {
    initAlerts();
  } catch (e) {
    console.error("[server] initAlerts failed:", e?.message);
  }
});

// Helper: yesterday's date in ET (YYYY-MM-DD).
function yesterdayET() {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  return y.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function todayET() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

// 12:00 PM ET — Morning Snapshot of TODAY so far (midnight to noon ET).
cron.schedule(
  "0 12 * * *",
  async () => {
    console.log(`[cron] morning report starting`);
    try {
      await runMorningReport();
      console.log(`[cron] morning report sent`);
    } catch (e) {
      console.error(`[cron] morning report failed`, e);
    }
  },
  { timezone: config.timezone }
);

// 9:00 PM ET — Evening Snapshot of TODAY (full day so far).
// Same renderer as the 7 AM next-day report, but covers TODAY rather than yesterday.
// Gives Alex a near-end-of-business read on how the day went before the official
// next-morning recap fires at 7 AM.
cron.schedule(
  "0 21 * * *",
  async () => {
    const dateOverride = todayET();
    console.log(`[cron] evening snapshot (today=${dateOverride}) starting`);
    try {
      await runEveningReport({ dateOverride });
      console.log(`[cron] evening snapshot sent`);
    } catch (e) {
      console.error(`[cron] evening snapshot failed`, e);
    }
  },
  { timezone: config.timezone }
);

// 7:00 AM ET — Full Day Summary of YESTERDAY.
// When Alex opens his inbox at 7 AM Tuesday, he sees Monday's complete recap.
cron.schedule(
  "0 7 * * *",
  async () => {
    const dateOverride = yesterdayET();
    console.log(`[cron] evening report (yesterday=${dateOverride}) starting`);
    try {
      await runEveningReport({ dateOverride });
      console.log(`[cron] evening report sent`);
    } catch (e) {
      console.error(`[cron] evening report failed`, e);
    }
  },
  { timezone: config.timezone }
);

console.log(
  `[cron] scheduled morning=12:00 evening_snapshot=21:00(today) yesterday_recap=07:00 tz=${config.timezone}`
);

// =====================================================================
// Firehose backfill — keeps local SQLite calls table fresh.
// Without this the calls table only gets data when /admin/debug/firehose-backfill
// is hit manually. Two crons:
//   1. Every 15 min from 6 AM to 10 PM ET  → today (live freshness)
//   2. 2 AM ET nightly                     → yesterday (so 7 AM evening report is solid)
// =====================================================================
cron.schedule(
  "*/15 6-22 * * *",
  async () => {
    const dateStr = todayET();
    console.log("[firehose-backfill-cron] running for", dateStr);
    try {
      const r = await backfillDate(dateStr);
      console.log("[firehose-backfill-cron] OK", r);
    } catch (e) {
      console.error("[firehose-backfill-cron] ERR", (e && e.message) || e);
    }
  },
  { timezone: "America/New_York" }
);

cron.schedule(
  "0 2 * * *",
  async () => {
    const dateStr = yesterdayET();
    console.log("[firehose-backfill-cron] nightly catch-up for", dateStr);
    try {
      const r = await backfillDate(dateStr);
      console.log("[firehose-backfill-cron] nightly OK", r);
    } catch (e) {
      console.error("[firehose-backfill-cron] nightly ERR", (e && e.message) || e);
    }
  },
  { timezone: "America/New_York" }
);

// =====================================================================
// JWT refresh cron — refreshes the Firebase access token every 5 minutes.
// The Firebase id_token (used as token-id when calling backend.leadconnectorhq.com)
// expires in ~1 hour. Refreshing every 5 min keeps it well within validity.
// Without this, the firehose-backfill cron silently fails with 401 after ~1 hour.
// =====================================================================
cron.schedule(
  "*/5 * * * *",
  async () => {
    console.log("[jwt-refresh-cron] running at", new Date().toISOString());
    try {
      const r = await refreshStoredJwt();
      console.log("[jwt-refresh-cron] OK", r);
    } catch (e) {
      console.error("[jwt-refresh-cron] ERR", (e && e.message) || e);
    }
  },
  { timezone: "America/New_York" }
);

// =====================================================================
// Morning catch-up (v20.2). 8:15 AM ET — scan every lead that arrived
// overnight (9 PM previous day through 8 AM today) and emit a single
// summary email listing any that still haven't been contacted by the
// dispatchers. Overnight leads do NOT get the live 3-min / 10-min timers,
// so this is their only alert path.
// =====================================================================
cron.schedule(
  "15 8 * * *",
  async () => {
    console.log("[morning-catchup-cron] running at", new Date().toISOString());
    try {
      const r = await runMorningCatchUp();
      console.log(
        `[morning-catchup-cron] OK overnight=${r.overnightContactCount} uncontacted=${r.uncontactedCount}`
      );
    } catch (e) {
      console.error("[morning-catchup-cron] ERR", (e && e.message) || e);
    }
  },
  { timezone: "America/New_York" }
);

// =====================================================================
// Dispatcher-idle cron (v20). Every 5 min between 8 AM and 8 PM ET (so the
// last evaluation happens at 8:55 PM, comfortably inside the 9 PM shift end).
// checkIdleDispatchers() already gates on each dispatcher's individual shift
// window, on idleAlertsExcluded, and on Hubstaff break status.
// =====================================================================
cron.schedule(
  "*/5 8-20 * * *",
  async () => {
    console.log("[idle-cron] running at", new Date().toISOString());
    try {
      const r = await checkIdleDispatchers();
      console.log(
        `[idle-cron] OK fired=${r.fired} skipped=${r.skipped.length} evaluated=${r.evaluated.length} suppressed_break=${r.suppressedByBreak} cooldown=${r.suppressedByCooldown}`
      );
    } catch (e) {
      console.error("[idle-cron] ERR", (e && e.message) || e);
    }
  },
  { timezone: "America/New_York" }
);

// NOTE — explicitly NOT scheduled in this round:
//   - Hourly verification reports
//     Were noisy; disabled May 7 2026, kept off in v20.
