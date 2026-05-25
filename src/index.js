// Entry point. Boots the HTTP server (for the GHL webhook + healthz) and
// schedules the daily reports via node-cron in the configured timezone.
//
// SCHEDULE (v20.9, locked May 24 2026):
//   12:00 PM ET     Morning Snapshot — today midnight to noon
//   10:00 PM ET     Evening / Full-Day report — today (full-day-to-date)
//    2:00 AM ET     Firehose backfill for yesterday
//    8:30 AM ET     Morning catch-up — overnight leads still uncontacted
//   */15 6-22 ET    Firehose backfill for today (every 15 min during business hours)
//   */5  *   *      JWT refresh (Firebase id_token expires in ~1hr; refresh keeps backfill alive)
//
// Per Alex (May 24 2026): removed the 7 AM yesterday-recap email and the
// dispatcher-idle (15-min no-call) alerts entirely. Idle code is kept in
// idle.js + the /admin/debug/check-idle endpoint, but is no longer scheduled.
//
// On boot: re-arm any pending lead alerts from /var/data/pending-alerts.json so
// Render restarts don't lose mid-flight 10-min escalation timers.
import cron from "node-cron";
import { config } from "./config.js";
import { buildServer } from "./server.js";
import { runMorningReport, runEveningReport } from "./reports.js";
import { backfillDate, refreshStoredJwt } from "./firehose-backfill.js";
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

// 10:00 PM ET — Evening / Full-Day report of TODAY (full day so far).
// This is the nightly wrap-up Alex asked to lock at 10 PM.
cron.schedule(
  "0 22 * * *",
  async () => {
    const dateOverride = todayET();
    console.log(`[cron] evening report (today=${dateOverride}) starting`);
    try {
      await runEveningReport({ dateOverride });
      console.log(`[cron] evening snapshot sent`);
    } catch (e) {
      console.error(`[cron] evening snapshot failed`, e);
    }
  },
  { timezone: config.timezone }
);

console.log(
  `[cron] scheduled morning=12:00 evening=22:00(today) catchup=08:30 tz=${config.timezone}`
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
// Morning catch-up. 8:30 AM ET — scan every lead that arrived
// overnight (9 PM previous day through 8 AM today) and emit a single
// summary email listing any that still haven't been contacted by the
// dispatchers. Overnight leads do NOT get the live 3-min / 10-min timers,
// so this is their only alert path.
// =====================================================================
cron.schedule(
  "30 8 * * *",
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

// NOTE — explicitly NOT scheduled in this round:
//   - Hourly verification reports
//     Were noisy; disabled May 7 2026, kept off in v20.
