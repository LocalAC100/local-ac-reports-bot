// Jobber API client (GraphQL).
//
// Auth: Jobber uses OAuth 2.0. Access tokens expire every 60 minutes; we
// refresh using the client secret + a long-lived refresh token.
//
// Env vars required:
//   JOBBER_CLIENT_ID
//   JOBBER_CLIENT_SECRET
//   JOBBER_ACCESS_TOKEN   (initial, will be refreshed)
//   JOBBER_REFRESH_TOKEN  (for auto-refresh; obtained during OAuth flow)
//
// Without the refresh token we'll fall back to the static access token and
// fail gracefully with a clear "Jobber token expired" message when it dies.
import axios from "axios";

const GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";

let cachedAccessToken = process.env.JOBBER_ACCESS_TOKEN || null;
let cachedExpiry = null; // ms since epoch
let cachedRefreshToken = process.env.JOBBER_REFRESH_TOKEN || null;

async function refreshAccessToken() {
  if (!cachedRefreshToken) {
    throw new Error(
      "Jobber refresh token not configured — access token has expired and can't be refreshed automatically. Set JOBBER_REFRESH_TOKEN in Render env vars (obtained during OAuth)."
    );
  }
  const clientId = process.env.JOBBER_CLIENT_ID;
  const clientSecret = process.env.JOBBER_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET env vars required for token refresh.");
  }
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", cachedRefreshToken);
  params.append("client_id", clientId);
  params.append("client_secret", clientSecret);
  const resp = await axios.post(TOKEN_URL, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 15000,
  });
  cachedAccessToken = resp.data.access_token;
  if (resp.data.refresh_token) cachedRefreshToken = resp.data.refresh_token;
  cachedExpiry = Date.now() + (resp.data.expires_in ?? 3600) * 1000 - 60_000;
  return cachedAccessToken;
}

async function getAccessToken() {
  if (cachedExpiry && Date.now() < cachedExpiry && cachedAccessToken) {
    return cachedAccessToken;
  }
  if (cachedRefreshToken) {
    return await refreshAccessToken();
  }
  // No refresh available — just return the static token; if expired the API call will fail.
  return cachedAccessToken;
}

export async function gql(query, variables = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("No Jobber access token available. Add JOBBER_ACCESS_TOKEN to env.");
  }
  const resp = await axios.post(
    GRAPHQL_URL,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-JOBBER-GRAPHQL-VERSION": "2024-04-29",
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
  if (resp.data.errors) {
    const msg = resp.data.errors.map((e) => e.message).join("; ");
    throw new Error(`Jobber GraphQL error: ${msg}`);
  }
  return resp.data.data;
}

// ---------- Convenience query helpers ----------

export async function listJobs({ first = 20, status } = {}) {
  const data = await gql(
    `query Jobs($first: Int!, $filter: JobFilterAttributes) {
      jobs(first: $first, filter: $filter) {
        nodes {
          id
          jobNumber
          title
          jobStatus
          startAt
          endAt
          total
          client { name }
          property { address { street, city } }
        }
        totalCount
      }
    }`,
    { first, filter: status ? { status: [status] } : null }
  );
  return data.jobs;
}

export async function listRecentClients(first = 10) {
  const data = await gql(
    `query Clients($first: Int!) {
      clients(first: $first, sort: { key: CREATED_AT, direction: DESCENDING }) {
        nodes { id name emails { description } phones { description } createdAt }
        totalCount
      }
    }`,
    { first }
  );
  return data.clients;
}

export async function listInvoices({ first = 20, status } = {}) {
  const data = await gql(
    `query Invoices($first: Int!, $filter: InvoiceFilterAttributes) {
      invoices(first: $first, filter: $filter) {
        nodes {
          id invoiceNumber subject total amountOutstanding
          client { name }
          createdAt
          invoiceStatus
        }
        totalCount
      }
    }`,
    { first, filter: status ? { status: [status] } : null }
  );
  return data.invoices;
}

export async function todayScheduledItems() {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString();
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).toISOString();
  const data = await gql(
    `query ScheduledToday($start: ISO8601DateTime!, $end: ISO8601DateTime!) {
      scheduledItems(filter: { startAt: { after: $start, before: $end } }, first: 50) {
        nodes {
          ... on Visit { id title startAt endAt job { jobNumber client { name } } }
          ... on Assessment { id title startAt endAt }
        }
        totalCount
      }
    }`,
    { start, end }
  );
  return data.scheduledItems;
}

export async function whoAmI() {
  const data = await gql(
    `query Me { account { id name } }`
  );
  return data.account;
}
