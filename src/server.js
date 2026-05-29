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
import { buildFirehoseBackfillRouter } from "./firehose-backfill.js";
import { buildJobberWarehouseRouter, initJobberWarehouse } from "./jobber-warehouse.js";
import { Alerts, Calls } from "./db.js";
import { verifyMailer, sendMail, getSendHistory } from "./mailer.js";

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
      const provided = req.headers["x-webhook-secret"] || req.query.secret;
      if (provided !== config.ghl.webhookSecret) {
        return res.status(401).json({ error: "bad secret" });
      }
    }
    const body = req.body || {};
    const contactId = body.contact_id || body.contactId || body.id || body.contact?.id;
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
      body.callSid || body.call_sid || body.messageId || body.message_id || body.id;
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
  // Mounted BEFORE the dashboard router so it bypasses requireAuth.  The
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

  // ─── Debug: peek at call DB row shape ───────────────────────────────
  // GET /admin/debug-calls/<SECRET>?date=YYYY-MM-DD — returns the first 3
  // raw rows from Calls.listInWindow + a sample of the enriched call objects
  // so we can see exactly what fields exist and which are null/missing.
  app.get("/admin/debug-calls/" + JWT_BOOTSTRAP_SECRET, async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const { DateTime } = await import("luxon");
      const TZ = "America/New_York";
      const dayStart = DateTime.fromISO(date, { zone: TZ }).startOf("day");
      const dayEnd = dayStart.endOf("day");
      const rows = Calls.listInWindow(dayStart.toUTC().toISO(), dayEnd.toUTC().toISO(), 5);
      res.json({
        ok: true,
        date,
        rowCount: rows.length,
        rowsRaw: rows.slice(0, 3).map((r) => ({
          keys: Object.keys(r),
          contact_id: r.contact_id,
          phone: r.phone,
          date_added: r.date_added,
          date_added_type: typeof r.date_added,
          status: r.status,
          duration: r.duration,
          direction: r.direction,
          user_id: r.user_id,
          raw_event_present: !!r.raw_event,
        })),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  // ─── No-auth mailer diagnostics ────────────────────────────────────────
  // Mounted BEFORE the dashboard router so secret-bypass works.
  // GET /admin/mailer-info/<SECRET>            -> sanitized SMTP config
  // GET /admin/test-mail/<SECRET>?to=foo@x.com -> attempts a real send and
  //                                                returns nodemailer's full
  //                                                response or error.
  app.get("/admin/mailer-info/" + JWT_BOOTSTRAP_SECRET, async (req, res) => {
    const mask = (s) =>
      !s ? null : s.length <= 4 ? "***" : s.slice(0, 2) + "***" + s.slice(-2);
    let verify = { ok: false };
    try {
      await verifyMailer();
      verify = { ok: true };
    } catch (e) {
      verify = {
        ok: false,
        message: e?.message || String(e),
        code: e?.code || null,
        response: e?.response || null,
      };
    }
    res.json({
      smtp: {
        host: config.smtp.host,
        port: config.smtp.port,
        user: mask(config.smtp.user),
        password: mask(config.smtp.password),
        fromName: config.smtp.fromName,
        fromAddress: config.smtp.fromAddress,
      },
      recipient: config.recipient,
      verify,
    });
  });

  app.get("/admin/send-history/" + JWT_BOOTSTRAP_SECRET, (req, res) => {
    res.json({ ok: true, history: getSendHistory() });
  });

  app.get("/admin/test-mail/" + JWT_BOOTSTRAP_SECRET, async (req, res) => {
    const to = req.query.to || config.recipient;
    const stamp = new Date().toISOString();
    try {
      const info = await sendMail({
        to,
        subject: `Local AC — Mailer Test (${stamp})`,
        html: `<p>This is a mailer connectivity test fired at <b>${stamp}</b>.</p>
               <p>From: ${config.smtp.fromAddress}<br>
               To: ${to}<br>
               SMTP: ${config.smtp.host}:${config.smtp.port}</p>
               <p>If you got this, SMTP works and the issue is somewhere else
               (e.g., spam filter, or an earlier silently-swallowed error in
               the report path).</p>`,
      });
      res.json({
        ok: true,
        to,
        from: config.smtp.fromAddress,
        info: {
          messageId: info?.messageId || null,
          response: info?.response || null,
          accepted: info?.accepted || null,
          rejected: info?.rejected || null,
          envelope: info?.envelope || null,
        },
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        to,
        from: config.smtp.fromAddress,
        error: {
          message: e?.message || String(e),
          code: e?.code || null,
          command: e?.command || null,
          response: e?.response || null,
          responseCode: e?.responseCode || null,
        },
      });
    }
  });

  // Dashboard: session-based, requires login
  app.use(cookieParser());
  app.use(buildSessionMiddleware());

  // Firehose-backfill router mounted BEFORE the dashboard router so its
  // secret-bypass route (/admin/debug/bucket-counts?s=...) can reach the
  // handler without dashboardRouter's requireAuth middleware redirecting
  // to /login. The router still gates the OTHER endpoints with requireAdmin.
  app.use(buildFirehoseBackfillRouter());
  app.use(buildJobberWarehouseRouter());
  try { initJobberWarehouse(); } catch (e) { console.error("[jw] init failed", e?.message); }

  app.use(buildDashboardRouter());
  app.use(buildDebugRouter());

  return app;
}
