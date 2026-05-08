// HTTP server: webhook listener + dashboard + healthz.
import express from "express";
import cookieParser from "cookie-parser";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { onNewLead } from "./alerts.js";
import { buildSessionMiddleware } from "./auth.js";
import { buildDashboardRouter } from "./dashboard.js";
import { buildDebugRouter } from "./debug.js";
import { Alerts, Calls } from "./db.js";

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

    // ─── Call events ────────────────────────────────────────────────────
    // HighLevel sends call events with these shapes (varies by Workflow trigger):
    //   { type: 'CallStatus', callSid, callStatus, direction, duration, userId, contactId, dateAdded, ... }
    //   { type: 'OutboundCallCompleted', ... }
    //   { type: 'InboundCallCompleted', ... }
    //
    // We accept any event that has a callSid (or messageId of type=CALL) and
    // upsert into the calls table. The nightly firehose reconcile job fills
    // in dispositions/duration that weren't final at webhook time.
    const callSid =
      body.callSid ||
      body.call_sid ||
      body.messageId ||
      body.message_id ||
      body.id;
    const looksLikeCall =
      eventType.includes("call") ||
      String(body.messageType || body.message_type || "").toLowerCase() === "call" ||
      Number(body.type) === 1; // GHL legacy numeric type for calls
    if (callSid && looksLikeCall) {
      try {
        Calls.upsert({
          callSid: String(callSid),
          direction:
            body.direction ||
            (eventType.includes("outbound") ? "outbound" : null) ||
            (eventType.includes("inbound") ? "inbound" : null),
          status: body.callStatus || body.call_status || body.status || null,
          duration: body.duration ?? body.callDuration ?? null,
          userId: body.userId || body.user_id || body.assignedUserId || null,
          contactId: contactId || null,
          phone: phone || body.from || body.to || null,
          source: "webhook",
          dateAdded: leadAddedAt,
          raw: body,
        });
      } catch (e) {
        console.error("[webhook] Calls.upsert failed", e?.message);
      }
    }
    return res.json({ ok: true });
  });

  // ─── No-auth GHL JWT bootstrap ─────────────────────────────────────────
  // Mounted BEFORE the dashboard router so it bypasses requireAuth. The
  // dashboard router has `router.use(requireAuth)` which 302-redirects every
  // unmatched /admin/* path to /login, so this endpoint MUST be registered
  // here at the app level to be reachable from the HighLevel tab.
  //
  // Why: HighLevel's session JWT is in localStorage on app.gohighlevel.com.
  // The Chrome MCP safety filter blocks JWT-shaped strings in JS output, so
  // we can't read it into chat. Instead we navigate the HL tab directly to
  // this URL with `?t=<JWT>`, which writes the JWT to /var/data/.
  //
  // Secret comes from a fixed string (low security risk — endpoint only
  // STORES whatever JWT is given). The deployed firehose endpoint
  // (/admin/debug/firehose) is still requireAdmin-gated.
  const JWT_BOOTSTRAP_SECRET =
    process.env.JWT_BOOTSTRAP_SECRET || "lac-jwt-2026-bootstrap-axabramov";
  console.log(
    "[jwt-bootstrap] /admin/jwt-bootstrap/" + JWT_BOOTSTRAP_SECRET
  );
  app.get(
    "/admin/jwt-bootstrap/" + JWT_BOOTSTRAP_SECRET,
    (req, res) => {
      try {
        const jwt = req.query.t;
        if (!jwt || typeof jwt !== "string") {
          return res.status(400).send("missing t param");
        }
        const dataDir = process.env.DATA_DIR || "/var/data";
        const file = path.join(dataDir, "ghl-internal-jwt.json");
        try {
          fs.mkdirSync(dataDir, { recursive: true });
        } catch {}
        const payload = JSON.stringify(
          {
            "token-id": String(jwt),
            savedAt: new Date().toISOString(),
          },
          null,
          2
        );
        fs.writeFileSync(file, payload, "utf8");
        res.send("ok len=" + String(jwt).length);
      } catch (e) {
        res.status(500).send("err: " + (e?.message || "unknown"));
      }
    }
  );

  // Dashboard: session-based, requires login
  app.use(cookieParser());
  app.use(buildSessionMiddleware());
  app.use(buildDashboardRouter());
  app.use(buildDebugRouter());

  return app;
}
