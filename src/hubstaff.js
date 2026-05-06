// Hubstaff API client.
//
// Authentication: Hubstaff issues a refresh token (JWT) at
// developer.hubstaff.com. We exchange it for a short-lived access token via
// POST /access_tokens. The refresh token ROTATES on every exchange and is
// valid for 30 days from issuance — so if the bot sits idle for >30 days,
// the env var must be regenerated.
//
// To minimize rotation churn, we cache the access token in memory and only
// hit the refresh endpoint when expired.
import axios from "axios";
import { config } from "./config.js";
import { DateTime } from "luxon";

const ACCOUNT_BASE = "https://account.hubstaff.com";
const API_BASE = "https://api.hubstaff.com/v2";

let cachedAccessToken = null;
let cachedExpiry = null; // luxon DateTime
let currentRefreshToken = config.hubstaff.refreshToken;

async function refreshAccessToken() {
  const params = new URLSearchParams();
  params.append("grant_type", "refresh_token");
  params.append("refresh_token", currentRefreshToken);

  const resp = await axios.post(
    `${ACCOUNT_BASE}/access_tokens`,
    params.toString(),
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    }
  );

  const { access_token, refresh_token, expires_in } = resp.data;
  cachedAccessToken = access_token;
  cachedExpiry = DateTime.now().plus({ seconds: (expires_in ?? 7200) - 60 });
  // Hubstaff rotates refresh tokens. Keep the latest in memory; if the
  // process restarts, we fall back to the env var (which the user would have
  // updated if expired).
  if (refresh_token) currentRefreshToken = refresh_token;
}

async function getAccessToken() {
  if (
    !cachedAccessToken ||
    !cachedExpiry ||
    DateTime.now() >= cachedExpiry
  ) {
    await refreshAccessToken();
  }
  return cachedAccessToken;
}

async function get(path, params = {}) {
  const token = await getAccessToken();
  const resp = await axios.get(`${API_BASE}${path}`, {
    params,
    headers: { Authorization: `Bearer ${token}` },
    timeout: 30000,
  });
  return resp.data;
}

// ---------- Public helpers ----------

export async function listOrgUsers() {
  // Hubstaff /members returns membership records keyed by user_id (no email/name).
  // We sideload the user records via ?include=users so each returned object
  // has BOTH the membership info AND id/name/email/last_activity merged.
  const data = await get(`/organizations/${config.hubstaff.orgId}/members`, {
    include: "users",
  });
  const members = data?.members ?? [];
  const users = data?.users ?? [];
  const userById = new Map(users.map((u) => [u.id, u]));
  return members.map((m) => {
    const u = userById.get(m.user_id) || {};
    return {
      // user-level fields (what callers expect)
      id: u.id ?? m.user_id,
      name: u.name,
      first_name: u.first_name,
      last_name: u.last_name,
      email: u.email,
      time_zone: u.time_zone,
      status: u.status,
      last_activity: u.last_activity ?? m.last_client_activity ?? null,
      // membership-level fields preserved
      user_id: m.user_id,
      membership_role: m.membership_role,
      membership_status: m.membership_status,
      pay_period: m.pay_period,
      trackable: m.trackable,
      effective_role: m.effective_role,
    };
  });
}

// activities: per-user time entries with activity %, broken into 10-min slots
// from/to are ISO strings (UTC); Hubstaff converts using the org timezone.
export async function getActivities({ from, to, userIds }) {
  const params = {
    "time_slot[start]": from,
    "time_slot[stop]": to,
    page_limit: 500,
  };
  if (userIds?.length) params["user_ids[]"] = userIds;
  const data = await get(
    `/organizations/${config.hubstaff.orgId}/activities`,
    params
  );
  return data?.activities ?? [];
}

export async function getDailyActivities({ date, userIds }) {
  // Hubstaff's "daily activities" endpoint returns one row per user per day.
  const params = {
    "date[start]": date,
    "date[stop]": date,
    page_limit: 500,
  };
  if (userIds?.length) params["user_ids[]"] = userIds;
  const data = await get(
    `/organizations/${config.hubstaff.orgId}/activities/daily`,
    params
  );
  return data?.daily_activities ?? [];
}

// Screenshots from Hubstaff. Each screenshot has a URL we can pull and hash.
export async function getScreenshots({ from, to, userIds }) {
  const params = {
    "time_slot[start]": from,
    "time_slot[stop]": to,
    page_limit: 500,
  };
  if (userIds?.length) params["user_ids[]"] = userIds;
  const data = await get(
    `/organizations/${config.hubstaff.orgId}/screenshots`,
    params
  );
  return data?.screenshots ?? [];
}

// Time entries (clock-in / clock-out) for the day.
export async function getTimesheets({ from, to, userIds }) {
  const params = {
    "time[start]": from,
    "time[stop]": to,
    page_limit: 500,
  };
  if (userIds?.length) params["user_ids[]"] = userIds;
  const data = await get(
    `/organizations/${config.hubstaff.orgId}/timesheets`,
    params
  );
  return data?.timesheets ?? [];
}
