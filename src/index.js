// Entry point. Boots the HTTP server (for the GHL webhook + healthz) and
// schedules the two daily reports via node-cron in the configured timezone.
import cron from "node-cron";
import { config } from "./config.js";
import { buildServer } from "./server.js";
import { runMorningReport, runEveningReport } from "./reports.js";

const app = buildServer();
app.listen(config.port, () => {
  console.log(`[server] listening on:${config.port} tz=${config.timezone}`);
});

