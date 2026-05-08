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

// Hourly verification reports — TEMPORARY, while we iterate on report
// accuracy. Fires the full-day summary every hour at the top of the hour
// from 9 AM to 7 PM ET, so Alex can compare the running numbers against
// reality after each fix. Skips 12 PM (morning report fires there) and
// 7 PM (the 7:30 PM evening report is close enough). Remove when reports
// are verified bug-free.
cron.schedule(
  "0 9-19 * * *",
  async () => {
    const hour = new Date().toLocaleString("en-US", {
      timeZone: config.timezone,
      hour: "numeric",
      hour12: false,
    });
    if (hour === "12" || hour === "19") return;
    console.log(`[cron] hourly report starting @ ${hour}:00`);
    try {
      await runEveningReport();
      console.log(`[cron] hourly report sent`);
    } catch (e) {
      console.error(`[cron] hourly report failed`, e);
    }
  },
  { timezone: config.timezone }
);

console.log(
  `[cron] scheduled morning=12:00 evening=19:30 hourly=9-19/skip-12-19 idle=*/5 8-20 tz=${config.timezone}`
);
