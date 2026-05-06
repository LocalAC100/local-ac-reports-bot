// Entry point. Boots the HTTP server (for the GHL webhook + healthz) and
// schedules the two daily reports via node-cron in the configured timezone.
import cron from "node-cron";
import { config } from "./config.js";
import { buildServer } from "./server.js";
import { runMorningReport, runEveningReport } from "./reports.js";
import * as jobberSync from "./jobber-sync.js";
import * as sheets from "./sheets.js";
import * as gmail from "./gmail.js";

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

// ---------- Gross Profit syncs ----------
// Each runs a poll/scan every interval. They no-op when not configured,
// so it's safe to schedule them before Jobber/Sheets/Gmail credentials land.

// Jobber poll (safety net behind the webhook): every 30 minutes
cron.schedule("*/30 * * * *", async () => {
  try {
    const r = await jobberSync.pollOnce();
    if (!r.skipped) console.log(`[cron] jobber poll`, r);
  } catch (e) {
    console.error(`[cron] jobber poll failed`, e?.message);
  }
});

// Chris's sheet scan: every 30 minutes (offset by 15 min so we don't stack)
cron.schedule("15,45 * * * *", async () => {
  try {
    const r = await sheets.scanChrisSheet();
    if (!r.skipped) console.log(`[cron] sheets scan`, r);
  } catch (e) {
    console.error(`[cron] sheets scan failed`, e?.message);
  }
});

// Gmail watcher: every 15 minutes
cron.schedule("*/15 * * * *", async () => {
  try {
    const r = await gmail.pollOnce();
    if (!r.skipped) console.log(`[cron] gmail poll`, r);
  } catch (e) {
    console.error(`[cron] gmail poll failed`, e?.message);
  }
});

// Mirror sheet sync: every 10 minutes (cheap; just overwrites)
cron.schedule("*/10 * * * *", async () => {
  try {
    const r = await sheets.syncMirror();
    if (!r.skipped) console.log(`[cron] mirror sync`, r);
  } catch (e) {
    console.error(`[cron] mirror sync failed`, e?.message);
  }
});

console.log(`[cron] gross profit syncs scheduled (jobber=30m, sheets=30m, gmail=15m, mirror=10m)`);

