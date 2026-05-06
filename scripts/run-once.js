// Run a single report on demand instead of waiting for cron.
//   node scripts/run-once.js morning   — real morning report
//   node scripts/run-once.js evening   — real evening report
//   node scripts/run-once.js test      — sample data preview (no live data fetch)
import { runMorningReport, runEveningReport, runTestReport } from "../src/reports.js";

const which = process.argv[2];
if (!["morning", "evening", "test"].includes(which)) {
  console.error("Usage: node scripts/run-once.js [morning|evening|test]");
  process.exit(2);
}

(async () => {
  try {
    if (which === "morning") await runMorningReport();
    else if (which === "evening") await runEveningReport();
    else await runTestReport();
    console.log("✓ report sent");
  } catch (e) {
    console.error("✗ failed", e?.response?.data || e);
    process.exit(1);
  }
})();
