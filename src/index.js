// Entry point. Boots the HTTP server (for the GHL webhook + healthz) and
// schedules the two daily reports via node-cron in the configured timezone.
import cron from "node-cron";
import { config } from "./config.js";
import { buildServer } from "./server.js";
import { runMorningReport, runEveningReport } from "./reports.js";

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

console.log(`[cron] scheduled morning=12:00 evening=19:30 tz=${config.timezone}`);
