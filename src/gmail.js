// Placeholder gmail module.
// Real Gmail polling for invoice attachments will be implemented in the next conversation
// when the Jobber + Sheets tab is wired up. This stub keeps the cron from crashing.

export async function pollOnce() {
  return { skipped: true, reason: "gmail module not yet configured" };
}
