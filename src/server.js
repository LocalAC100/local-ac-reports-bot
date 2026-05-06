// HTTP server: webhook listener + dashboard + healthz.
import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { onNewLead } from "./alerts.js";
import { buildSessionMiddleware } from "./auth.js";
import { buildDashboardRouter } from "./dashboard.js";
import { Alerts } from "./db.js";
import * as jobberSync from "./jobber-sync.js";
import axios from "axios";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildServer() {
  const app = express();

  // Trust Render's proxy so secure cookies + req.ip work correctly
  app.set("trust proxy", 1);

  // Health check (no auth, no body parsing — fast)
  app.get("/healthz", (req, res) => res.json({ ok: true }));

  // Static assets (logo, css)
  app.use(express.static(path.join(__dirname, "..", "public")));

  // GHL webhook — needs JSON body parsing, but NOT session middleware
  // (webhooks don't have sessions). Mount before session.
  app.post("/webhooks/ghl", express.json({ limit: "1mb" }), (req, res) => {
    if (config.ghl.webhookSecret) {
      const provided =
        req.headers["x-webhook-secret"] || req.query.secret;
      if (provided !== config.ghl.webhookSecret) {
        return res.status(401).json({ error: "bad secret" });
      }
    }

    const body = req.body || {};
    const contactId =
      body.contact_id || body.contactId || body.id || body.contact?.id;
    const contactName =
      body.full_name ||
      body.fullName ||
      `${body.first_name ?? body.firstName ?? ""} ${body.last_name ?? body.lastName ?? ""}`.trim() ||
      body.contact?.name;
    const phone = body.phone || body.contact?.phone;
    const leadAddedAt =
      body.date_added ||
      body.dateAdded ||
      body.contact?.dateAdded ||
      new Date().toISOString();
    const eventType = String(body.type ?? body.event_type ?? "").toLowerCase();

    if (
      !eventType ||
      eventType.includes("contact") ||
      eventType.includes("lead") ||
      eventType.includes("create")
    ) {
      // Log to dashboard immediately (so it appears in Alerts even before timer fires)
      onNewLead({ contactId, contactName, phone, leadAddedAt }).catch((e) =>
        console.error("[webhook] onNewLead failed", e?.message)
      );
    }
    return res.json({ ok: true });
  });

  // Jobber webhook â INVOICE_CREATE (and other topics). Mount before session.
  // Jobber posts a small envelope; we fetch full invoice detail in the handler.
  app.post("/webhooks/jobber", express.raw({ type: "application/json", limit: "1mb" }), async (req, res) => {
    const rawBody = req.body; // Buffer because of express.raw
    const sig = req.headers["x-jobber-hmac-sha256"] || req.headers["x-jobber-signature"];
    if (!jobberSync.verifyWebhookSignature(rawBody, sig)) {
      return res.status(401).json({ error: "bad signature" });
    }
    let body;
    try { body = JSON.parse(rawBody.toString("utf8")); }
    catch { return res.status(400).json({ error: "bad json" }); }

    // Jobber webhook envelope: { data: { webHookEvent: { topic, itemId, accountId, occurredAt } } }
    const evt = body?.data?.webHookEvent || body?.webHookEvent || body;
    const topic = String(evt?.topic || "").toUpperCase();
    const itemId = evt?.itemId || evt?.item?.id;

    if (topic.includes("INVOICE") && itemId) {
      // Async; respond fast so Jobber doesn't retry
      jobberSync.upsertInvoice(itemId).catch((e) =>
        console.error("[jobber-webhook] upsertInvoice failed", e?.message)
      );
    }
    return res.json({ ok: true });
  });

  // Jobber OAuth callback. Exchanges the auth code for access + refresh tokens
  // and persists them to /var/data/jobber-tokens.json. Mount before session.
  // One-time setup; remove or restrict after first use.
  app.get("/jobber/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send("missing ?code in callback URL");
    const clientId = process.env.JOBBER_CLIENT_ID;
    const clientSecret = process.env.JOBBER_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return res.status(500).send("JOBBER_CLIENT_ID / JOBBER_CLIENT_SECRET not in env");
    }
    try {
      const params = new URLSearchParams();
      params.append("grant_type", "authorization_code");
      params.append("code", code);
      params.append("client_id", clientId);
      params.append("client_secret", clientSecret);
      params.append("redirect_uri", "https://local-ac-reports-bot.onrender.com/jobber/callback");
      const r = await axios.post(
        "https://api.getjobber.com/api/oauth/token",
        params.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
      );
      const { access_token, refresh_token, expires_in } = r.data;
      // Persist for the running process AND for restarts
      const dataDir = process.env.RENDER ? "/var/data" : "./data";
      try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
      const path = `${dataDir}/jobber-tokens.json`;
      fs.writeFileSync(path, JSON.stringify({
        access_token, refresh_token, expires_in,
        obtained_at: new Date().toISOString(),
      }, null, 2));
      // Also push into process.env so jobber.js picks them up immediately
      process.env.JOBBER_ACCESS_TOKEN = access_token;
      if (refresh_token) process.env.JOBBER_REFRESH_TOKEN = refresh_token;
      res.send(`<html><body style="font-family:monospace;padding:24px">
        <h2>Jobber tokens captured ✓</h2>
        <p>Saved to ${path} and pushed to process.env. The app can now use Jobber.</p>
        <p>For persistence across restarts, also paste these into Render env vars:</p>
        <pre style="background:#f5f5f5;padding:12px;overflow:auto">
JOBBER_ACCESS_TOKEN=${access_token}
JOBBER_REFRESH_TOKEN=${refresh_token || "(rotation off; reuse access token)"}
        </pre>
        <p>Expires in: ${expires_in}s</p>
        <p><a href="/gross-profit">→ go to Gross Profit page</a></p>
      </body></html>`);
    } catch (e) {
      const detail = e.response?.data ? JSON.stringify(e.response.data) : e.message;
      res.status(500).send(`Token exchange failed: ${detail}`);
    }
  });

  // Dashboard: session-based, requires login
  app.use(cookieParser());
  app.use(buildSessionMiddleware());
  app.use(buildDashboardRouter());

  return app;
}
