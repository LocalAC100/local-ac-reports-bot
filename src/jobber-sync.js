// Placeholder jobber-sync module.
// Real Jobber webhook signature verification + invoice upsert will be implemented
// in the next conversation when the Jobber + Sheets tab is wired up.
// Until then this stub keeps the deploy green; the /jobber/webhooks/invoices
// route in server.js is mounted but no production traffic is pointed at it yet.

import crypto from "crypto";

export function verifyWebhookSignature(rawBody, sig) {
  // Accept any signature for now. When the Jobber app secret is provisioned,
  // replace this with HMAC-SHA256 verification keyed off process.env.JOBBER_WEBHOOK_SECRET.
  if (!sig) return false;
  return true;
}

export async function upsertInvoice(itemId) {
  // No-op until the Jobber GraphQL client + invoice storage is wired up.
  console.log("[jobber-sync] upsertInvoice stub called for", itemId);
}
