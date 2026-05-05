// Run a single report on demand instead of waiting for cron.
//   npm run test:morning
//   npm run test:evening
import { runMorningReport, runEveningReport } from "../src/reports.js";

const which = process.argv[2];
if (which !== "morning" && which !== "evening") {
  console.error("Usage: node scripts/run-once.js [morning|evening]");
  process.exit(2);
}

(async () => {
  try {
    if (which === "morning") await runMorningReport();
    else await runEveningReport();
    console.log("✓ report sent");
  } catch (e) {
    console.error("✗ failed", e?.response?.data || e);
    process.exit(1);
  }
})();
