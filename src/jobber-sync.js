// Jobber ÃÂ¢ÃÂÃÂ Gross Profit sync.
//
// Two paths into the same upsert:
//   1. Webhook  POST /webhooks/jobber  (real-time, when JOBBER_WEBHOOK_SECRET is set)
//   2. Cron poll  every 30 min        (safety net for missed events)
//
// Both call into GpJobs.upsertFromInvoice which is idempotent on jobber_invoice_id.

import crypto from "crypto";
import { gql, tokenStatus } from "./jobber.js";
import { GpJobs, GpAttachments } from "./gross-profit.js";

// ---------- Configuration ----------
export function isConfigured() {
  // jobber.js loads tokens from /var/data/jobber-tokens.json on boot,
  // so check that cache (not just env vars).
  const t = tokenStatus();
  return t.has_access_token || t.has_refresh_token;
}

// ---------- GraphQL: fetch full invoice detail by id ----------
async function fetchInvoiceDetail(invoiceId) {
  // Jobber's 2025 schema: amountPaid/amountOutstanding/property/payments
  // were removed/renamed. We fetch what's still available and infer the
  // rest. property.address has to be re-fetched via the property ID.
  const data = await gql(
    `query InvoiceDetail($id: EncodedId!) {
      invoice(id: $id) {
        id
        invoiceNumber
        subject
        total
        invoiceStatus
        issuedDate
        createdAt
        paymentsTotal
        client {
          id
          name
          firstName
          lastName
          companyName
        }
        propertyIds
        lineItems {
          nodes {
            id
            name
            description
            quantity
            totalPrice
            unitPrice
          }
        }
      }
    }`,
    { id: invoiceId }
  );
  const invoice = data?.invoice;
  if (!invoice) return null;
  // Best-effort property fetch (address) using first propertyId.
  const propId = invoice.propertyIds?.[0];
  if (propId) {
    try {
      const p = await gql(
        `query Prop($id: EncodedId!) {
          property(id: $id) {
            id
            address { street, city, postalCode, province }
          }
        }`,
        { id: propId }
      );
      invoice.property = p?.property;
    } catch (e) {
      // ignore ÃÂ¢ÃÂÃÂ address will be null
    }
  }
  return invoice;
}

// ---------- List recent invoices for polling ----------
async function listRecentInvoiceIds({ first = 50 } = {}) {
  const data = await gql(
    `query RecentInvoices($first: Int!) {
      invoices(first: $first, sort: { key: CREATED_AT, direction: DESCENDING }) {
        nodes { id createdAt }
      }
    }`,
    { first }
  );
  return data?.invoices?.nodes || [];
}

// ---------- Upsert one invoice into GP ----------
function paymentMethodFrom(invoice) {
  // Jobber 2025 schema removed invoice.payments. Until we wire up a
  // separate payment query, leave payment_method null. The total paid
  // amount is in invoice.paymentsTotal (a number).
  return null;
}

function feeFrom(invoice) {
  // The spec mentions "Financing or CC Fee". Jobber doesn't expose this on
  // a structured field ÃÂ¢ÃÂÃÂ usually it shows up as a line-item adjustment.
  // We make a best-effort: any line item whose name matches /fee/i is treated
  // as the fee. Returns { amount, type } or { amount: null, type: null }.
  const items = invoice.lineItems?.nodes || [];
  const fee = items.find((li) => /\bfee\b/i.test(li.name || "") || /\bfee\b/i.test(li.description || ""));
  if (!fee) return { amount: null, type: null };
  const desc = (fee.name || fee.description || "").toLowerCase();
  let type = "fee";
  if (desc.includes("financ")) type = "financing";
  else if (desc.includes("card") || desc.includes("cc")) type = "cc";
  return { amount: fee.totalPrice, type };
}

function customerNameFrom(invoice) {
  const c = invoice.client || {};
  return c.companyName || c.name ||
    [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
    null;
}

export async function upsertInvoice(invoiceId) {
  const inv = await fetchInvoiceDetail(invoiceId);
  if (!inv) {
    console.warn(`[jobber-sync] invoice ${invoiceId} not found`);
    return null;
  }
  const addr = inv.property?.address || {};
  const fee = feeFrom(inv);
  const lineItems = (inv.lineItems?.nodes || [])
    // Exclude the fee line so we don't double-count
    .filter((li) => !/\bfee\b/i.test(li.name || "") && !/\bfee\b/i.test(li.description || ""))
    .map((li) => ({
      description: li.name || li.description || "",
      amount: li.totalPrice,
    }));

  const jobId = GpJobs.upsertFromInvoice({
    jobberInvoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    clientId: inv.client?.id,
    issuedAt: inv.issuedDate || inv.createdAt,
    customerName: customerNameFrom(inv),
    address: addr.street,
    city: addr.city,
    zip: addr.postalCode,
    amountPaid: (() => {
      const direct = Number(inv.paymentsTotal) || 0;
      const status = String(inv.invoiceStatus || "").toLowerCase();
      // Treat invoice as fully paid when Jobber says so (covers financed installs)
      if (status === "paid") return Number(inv.total) || direct;
      return direct;
    })(),
    invoiceTotal: inv.total,
    paymentMethod: paymentMethodFrom(inv),
    feeAmount: fee.amount,
    feeType: fee.type,
    lineItems,
  });

  // Try to attach the invoice PDF. Jobber's PDF download isn't part of the
  // GraphQL API ÃÂ¢ÃÂÃÂ we'd need a separate REST endpoint. For now, log a TODO
  // so we can wire that up once we confirm the URL pattern.
  // TODO: download PDF via Jobber's invoice PDF endpoint and call GpAttachments.save

  return jobId;
}

// ---------- Webhook ----------
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.JOBBER_WEBHOOK_SECRET;
  if (!secret) return true; // no secret configured = skip verification (dev-only)
  if (!signatureHeader) return false;
  const computed = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  // Constant-time compare
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(String(signatureHeader))
    );
  } catch {
    return false;
  }
}

// ---------- Backfill (paginated, year-scoped) ----------
//
// One-time pull of every invoice issued on or after a given date. Uses
// Jobber's relay-style pagination ÃÂ¢ÃÂÃÂ keeps requesting next pages until
// either we run out of data or hit a reasonable cap.
async function listInvoicesPage({ first = 100, after = null, issuedAfter }) {
  const data = await gql(
    `query InvoicesPage($first: Int!, $after: String, $filter: InvoiceFilterAttributes) {
      invoices(first: $first, after: $after, filter: $filter, sort: { key: ISSUED_DATE, direction: ASCENDING }) {
        nodes { id issuedDate createdAt }
        pageInfo { hasNextPage endCursor }
      }
    }`,
    { first, after, filter: issuedAfter ? { issuedDate: { after: issuedAfter } } : null }
  );
  return data?.invoices;
}

export async function backfillSince(isoDate, { hardCap = 5000 } = {}) {
  if (!isConfigured()) {
    return { skipped: true, reason: "Jobber not configured" };
  }
  let after = null;
  let scanned = 0, synced = 0, errors = 0;
  while (scanned < hardCap) {
    let page;
    try {
      page = await listInvoicesPage({ first: 100, after, issuedAfter: isoDate });
    } catch (e) {
      return { scanned, synced, errors, error: e.message };
    }
    const nodes = page?.nodes || [];
    if (nodes.length === 0) break;
    for (const node of nodes) {
      scanned++;
      // Skip only if the row exists AND already has invoice_total. Allows re-running
      // backfill to populate new fields on previously-synced rows.
      // Always refresh — amount_paid in particular needs re-syncing for
      // invoices that became fully paid (financing settlement) since last run.
      try {
        await upsertInvoice(node.id);
        synced++;
      } catch (e) {
        errors++;
        console.warn(`[jobber-sync] backfill upsert ${node.id} failed:`, e.message);
      }
    }
    if (!page.pageInfo?.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return { scanned, synced, errors, since: isoDate };
}

export async function backfillThisCalendarYear() {
  const start = `${new Date().getFullYear()}-01-01`;
  return backfillSince(start);
}

// ---------- Polling cron ----------
//
// Every 30 minutes we ask for the 50 newest invoices; if any have IDs we
// haven't seen, we fetch their detail and upsert. Cheap and idempotent.
import { db } from "./db.js";

export async function pollOnce({ window = 50 } = {}) {
  if (!isConfigured()) {
    console.log("[jobber-sync] not configured (no JOBBER_REFRESH_TOKEN), skipping poll");
    return { synced: 0, skipped: true };
  }
  let recent;
  try {
    recent = await listRecentInvoiceIds({ first: window });
  } catch (e) {
    console.warn("[jobber-sync] poll list failed:", e.message);
    return { synced: 0, error: e.message };
  }
  let synced = 0;
  for (const node of recent) {
    const have = db
      .prepare("SELECT 1 AS x FROM gp_jobs WHERE jobber_invoice_id = ?")
      .get(node.id);
    if (have) continue;
    try {
      await upsertInvoice(node.id);
      synced++;
    } catch (e) {
      console.warn(`[jobber-sync] upsert ${node.id} failed:`, e.message);
    }
  }
  return { synced, scanned: recent.length };
}
