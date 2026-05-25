// Loads and validates environment variables. Fails fast on missing values
// so we don't silently misbehave at 12:00 PM with no token.
import dotenv from "dotenv";
dotenv.config();

function req(name, { fallback } = {}) {
  const v = process.env[name];
  if (!v && fallback === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v ?? fallback;
}

export const config = {
  hubstaff: {
    refreshToken: req("HUBSTAFF_REFRESH_TOKEN"),
    orgId: req("HUBSTAFF_ORG_ID"),
  },
  ghl: {
    apiKey: req("GHL_LOCATION_API_KEY"),
    locationId: req("GHL_LOCATION_ID"),
    webhookSecret: req("GHL_WEBHOOK_SECRET", { fallback: "" }),
  },
  smtp: {
    host: req("SMTP_HOST", { fallback: "smtp.gmail.com" }),
    port: parseInt(req("SMTP_PORT", { fallback: "587" }), 10),
    user: req("SMTP_USER"),
    password: req("SMTP_PASSWORD"),
    fromName: req("SMTP_FROM_NAME", { fallback: "Local AC Reports Bot" }),
    fromAddress: req("SMTP_FROM_ADDRESS"),
  },
  recipient: "service@local-ac.com, Christianq@local-ac.com",
  port: parseInt(req("PORT", { fallback: "3000" }), 10),
  timezone: req("TIMEZONE", { fallback: "America/New_York" }),
  leadResponseThresholdMinutes: parseInt(
    req("LEAD_RESPONSE_THRESHOLD_MINUTES", { fallback: "3" }),
    10
  ),
  nodeEnv: req("NODE_ENV", { fallback: "development" }),
};
