// Entry point. Boots the HTTP server (for the GHL webhook + healthz) and
// schedules the two daily reports via node-cron in the configured timezone.
import cron from "node-cron";
import { config } from "./config.js";
import { buildServer } from "./server.js";
import { runMorningReport, runEveningReport } from "./reports.js";
import { checkIdleDispatchers } from "./idle.js";

const app = buildServer();
app.listen(config.port, () => {
  console.log(`[server] listening on :${config.port} tz=${config.timezone}`);
});

// 12:00 PM ET every day
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

// 7:30 PM ET every day
cron.schedule(
  "30 19 * * *",
  async () => {
    console.log(`[cron] evening report starting`);
    try {
      await runEveningReport();
      console.log(`[cron] evening report sent`);
    } catch (e) {
      console.error(`[cron] evening report failed`, e);
    }
  },
  { timezone: config.timezone }
);

// Idle-dispatcher check — every 5 min from 8 AM to 8 PM ET (business hours).
// Fires a 🔴 alert if any on-shift dispatcher hasn't placed a call / Vonage
// note / SMS in 20+ minutes. 60-min cooldown per dispatcher.
cron.schedule(
  "*/5 8-20 * * *",
  async () => {
    try {
      await checkIdleDispatchers();
    } catch (e) {
      console.error(`[cron] idle check failed`, e);
    }
  },
  { timezone: config.timezone }
);

// Hourly verification reports — DISABLED May 7 2026 22:00 ET. Was sending too
// many noisy reports to Alex while we iterate on Hubstaff/GHL data fixes.
// Re-enable by uncommenting once Hubstaff bugs are fully fixed.
// cron.schedule(
//   "0 9-19 * * *",
//   async () => {
//     const hour = new Date().toLocaleString("en-US", {
//       timeZone: config.timezone,
//       hour: "numeric",
//       hour12: false,
//     });
//     if (hour === "12" || hour === "19") return;
//     console.log(`[cron] hourly report starting @ ${hour}:00`);
//     try {
//       await runEveningReport();
//       console.log(`[cron] hourly report sent`);
//     } catch (e) {
//       console.error(`[cron] hourly report failed`, e);
//     }
//   },
//   { timezone: config.timezone }
// );

console.log(
  `[cron] scheduled morning=12:00 evening=19:30 idle=*/5 8-20 tz=${config.timezone} (hourly disabled)`
);

// Firehose backfill cron — keeps local SQLite calls table fresh.
// Without this, the calls table only gets data when /admin/debug/firehose-backfill is hit manually.
import { backfillDate } from "./firehose-backfill.js";

// Every 15 minutes from 6 AM to 10 PM ET, refresh today's call data.
cron.schedule("*/15 6-22 * * *", async () => {
  const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  console.log("[firehose-backfill-cron] running for", dateStr);
  try {
    const r = await backfillDate(dateStr);
    console.log("[firehose-backfill-cron] OK", r);
  } catch (e) {
    console.error("[firehose-backfill-cron] ERR", e && e.message || e);
  }
}, { timezone: "America/New_York" });

// Nightly catch-up at 2 AM ET for yesterday's data.
cron.schedule("0 2 * * *", async () => {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const dateStr = y.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  console.log("[firehose-backfill-cron] nightly catch-up for", dateStr);
  try {
    const r = await backfillDate(dateStr);
    console.log("[firehose-backfill-cron] nightly OK", r);
  } catch (e) {
    console.error("[firehose-backfill-cron] nightly ERR", e && e.message || e);
  }
}, { timezone: "America/New_York" });
