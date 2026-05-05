// HTTP server: receives GHL webhooks and exposes a /healthz check.
import express from "express";
import { config } from "./config.js";
import { onNewLead } from "./alerts.js";

export function buildServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  // GHL webhook: fired on contact.created, opportunity events, etc.
  // Configure this URL inside GHL: Settings → Integrations → Webhooks (or
  // attach an outbound webhook step inside a workflow that fires on new
  // contact creation).
  app.post("/webhooks/ghl", (req, res) => {
    // Optional: shared-secret check via X-GHL-Signature or query param.
    if (config.ghl.webhookSecret) {
      const provided =
        req.headers["x-webhook-secret"] || req.query.secret;
      if (provided !== config.ghl.webhookSecret) {
        return res.status(401).json({ error: "bad secret" });
      }
    }

    const body = req.body || {};
    // GHL workflow-style webhooks deliver a flat object with contact fields;
    // contact-event webhooks wrap data differently. Be tolerant.
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
    const eventType = body.type || body.event_type || "";

    // We only act on new-lead-style events.
    if (
      !eventType ||
      eventType.toLowerCase().includes("contact") ||
      eventType.toLowerCase().includes("lead") ||
      eventType.toLowerCase().includes("create")
    ) {
      onNewLead({ contactId, contactName, phone, leadAddedAt }).catch((e) =>
        console.error("[webhook] onNewLead failed", e?.message)
      );
    }
    return res.json({ ok: true });
  });

  return app;
}
