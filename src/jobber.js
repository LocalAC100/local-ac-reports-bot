// Jobber API client (GraphQL).
//
// Auth: Jobber uses OAuth 2.0. Access tokens expire every 60 minutes; we
// refresh using the client secret + a long-lived refresh token.
//
// Token sources (checked in order on boot):
//   1. /var/data/jobber-tokens.json  (persistent disk; written by /jobber/callback
//      and updated on every refresh)
//   2. JOBBER_ACCESS_TOKEN / JOBBER_REFRESH_TOKEN env vars (fallback)
//
// Env vars required for refresh:
//   JOBBER_CLIENT_ID
//   JOBBER_CLIENT_SECRET

import axios from "axios";
import fs from "fs";

const GRAPHQL_URL = "https://api.getjobber.com/api/graphql";
const TOKEN_URL = "https://api.getjobber.com/api/oauth/token";
const TOKEN_FILE = process.env.RENDER ? "/var/data/jobber-tokens.json" : "./data/jobber-tokens.json";

let cachedAccessToken = null;
let cachedExpiry = null; // ms since epoch
let cachedRefreshToken = null;

// Boot: prefer disk-persisted tokens (from OAuth callback or last refresh)
function loadTokensFromDisk() {
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const j = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
      if (j.access_token) cachedAccessToken = j.access_token;
      if (j.refresh_token) cachedRefreshToken = j.refresh_token;
      if (j.obtained_at && j.expires_in) {
        cachedExpiry = new Date(j.obtained_at).getTime() + (j.expires_in * 1000) - 60_000;
      }
      console.log(`[jobber] loaded tokens from ${TOKEN_FILE}`);
      return true;
    }
  } catch (e) {
    console.warn(`[jobber] failed to load tokens from disk:`, e.message);
  }
  return false;
}
loadTokensFromDisk();
// Env vars are the fallback
if (!cachedAccessToken && process.env.JOBBER_ACCESS_TOKEN) cachedAccessToken = process.env.JOBBER_ACCESS_TOKEN;
if (!cachedRefreshToken && process.env.JOBBER_REFRESH_TOKEN) cachedRefreshToken = process.env.JOBBER_REFRESH_TOKEN;

function persistTokens() {
  try {
    const dir = TOKEN_FILE.split("/").slice(0, -1).join("/") || ".";
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      access_token: cachedAccessToken,
      refresh_token: cachedRefreshToken,
      expires_in: cachedExpiry ? Math.floor((cachedExpiry - Date.now()) / 1000) : null,
      obtained_at: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn(`[jobber] failed to persist tokens:`, e.message);
  }
}

async function refreshAccessToken() {
  if (!cachedRefreshToken) {
    throw new Error(
      "Jobber refresh token not configured — access token has expired and can't be refreshed automatically. Run the OAuth flow at /jobber/callback or set JOBBER_REFRESH_TOKEN in env."
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
  persistTokens();
  return cachedAccessToken;
}

async function getAccessToken() {
  if (cachedExpiry && Date.now() < cachedExpiry && cachedAccessToken) {
    return cachedAccessToken;
  }
  if (cachedRefreshToken) {
    return await refreshAccessToken();
  }
  // No refresh available — return the static token; if expired the API call will fail
  return cachedAccessToken;
}

// Used by /jobber/callback after a fresh OAuth — pushes tokens into the cache
// so the running process picks them up immediately (no restart needed).
export function setTokens({ access_token, refresh_token, expires_in }) {
  if (access_token) cachedAccessToken = access_token;
  if (refresh_token) cachedRefreshToken = refresh_token;
  if (expires_in) cachedExpiry = Date.now() + expires_in * 1000 - 60_000;
  persistTokens();
}

export function tokenStatus() {
  return {
    has_access_token: Boolean(cachedAccessToken),
    has_refresh_token: Boolean(cachedRefreshToken),
    expires_in_seconds: cachedExpiry ? Math.floor((cachedExpiry - Date.now()) / 1000) : null,
    source: fs.existsSync(TOKEN_FILE) ? "disk" : (process.env.JOBBER_ACCESS_TOKEN ? "env" : "none"),
  };
}

export async function gql(query, variables = {}) {
  const token = await getAccessToken();
  if (!token) {
    throw new Error("No Jobber access token available. Run OAuth at /jobber/callback or set JOBBER_ACCESS_TOKEN in env.");
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
