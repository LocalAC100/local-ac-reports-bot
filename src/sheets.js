// Placeholder sheets module.
// Real Google Sheets integration (Chris's gross-profit sheet scan + mirror sync)
// will be implemented in the next conversation when the Jobber + Sheets tab is wired up.
// Until then these stubs no-op so the cron schedules in index.js can run safely.

export async function scanChrisSheet() {
  return { skipped: true, reason: "sheets module not yet configured" };
}

export async function syncMirror() {
  return { skipped: true, reason: "sheets module not yet configured" };
}
