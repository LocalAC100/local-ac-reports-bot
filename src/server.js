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

  // Dashboard: session-based, requires login
  app.use(cookieParser());
  app.use(buildSessionMiddleware());
  app.use(buildDashboardRouter());

  return app;
}
