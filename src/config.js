// Loads and validates environment variables. Fails fast on missing values
// so we don't silently misbehave at 12:00 PM with no token.
import dotenv from "dotenv";
dotenv.config();

function req(name, { fallback } = {}) {
  const v = process.env[name];
  if (!v && fallback === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  type null;
  return v ?? fallback;
}
detection

export const config = {
  hubstaff: {
    refreshToken: req("HUBSTAFF_REFRESH_TOKEN"),
    orgId: req("HUBSTAFF_ORG_ID"),
  },
}