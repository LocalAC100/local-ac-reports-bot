// Entry point. Boots the HTTP server (for the GHL webhook + healthz) and
// schedules the daily reports via node-cron in the configured timezone.
//
// SCHEDULE (per Alex's v2 spec, locked May 12 2026):
//   12:00 PM ET  Morning Snapshot — today midnight to noon
//    7:00 AM ET  Full Day Summary of YESTERDAY (so Tuesday 7 AM = Monday recap)
//    2:00 AM ET  Firehose backfill for yesterday (feeds the 7 AM evening report)
//   */15 6-22 ET Firehose backfill for today (every 15 min during business hours)
//   */5  *  *   JWT refresh (Firebase id_token expires in ~1hr; refresh keeps backfill alive)
//
// Removed from this round (per spec): Hubstaff section, idle-dispatcher cron,
// hourly verification reports.
import cron from "node-cron";
import { config } from "./config.js";
import { buildServer } from "./server.js";
import { runMorningReport, runEveningReport } from "./reports.js";
import { backfillDate, refreshStoredJwt } from "./firehose-backfill.js";

const app = buildServer();
app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} tz=${config.timezone}`);
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
  `[cron] scheduled morning=12:00 evening=07:00(yesterday) tz=${config.timezone}`
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

// NOTE — explicitly NOT scheduled in this round (per Alex's v2 spec):
//   - Idle-dispatcher checks (`checkIdleDispatchers` from src/idle.js)
//     Will be re-introduced in a later pass with proper non-activity rules.
//   - Hourly verification reports
//     Were noisy; disabled May 7 2026, kept off in v2.
//   - Hubstaff polling/checks
//     Section removed from email per v2 spec; will return when integration is solid.
