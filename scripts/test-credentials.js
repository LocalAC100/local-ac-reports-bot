// Smoke test for all integrations. Run with `npm run test:creds`.
import { config } from "../src/config.js";
import * as hubstaff from "../src/hubstaff.js";
import * as ghl from "../src/ghl.js";
import { verifyMailer, sendMail } from "../src/mailer.js";

async function main() {
  console.log("Checking config...");
  console.log("  recipient:", config.recipient);
  console.log("  smtp:", config.smtp.host + ":" + config.smtp.port);
  console.log("  org:", config.hubstaff.orgId, "/ ghl:", config.ghl.locationId);

  console.log("\n[1/3] Hubstaff: fetching org users...");
  const users = await hubstaff.listOrgUsers();
  console.log(`  ✓ found ${users.length} users`);

  console.log("\n[2/3] GoHighLevel: listing pipelines + users...");
  const [pipelines, ghlUsers] = await Promise.all([
    ghl.listPipelines(),
    ghl.listUsers(),
  ]);
  console.log(`  ✓ ${pipelines.length} pipelines, ${ghlUsers.length} GHL users`);

  console.log("\n[3/3] SMTP: verifying...");
  await verifyMailer();
  console.log("  ✓ SMTP auth OK");

  console.log("\nSending test email to", config.recipient, "...");
  await sendMail({
    subject: "Local AC Reports Bot — credentials test",
    html: `<p>If you're reading this, all credentials are wired up correctly.</p>
  <ul>
  
  
  
  </bl>
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
(��auto>
   ✒ Concept:`,
   });
  console.log("  ✓ test email sent");
}

main().catch((e) => {
  console.error("\n✗ test failed");
  console.error(e?.response?.data || e);
  process.exit(1);
});
