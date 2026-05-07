// Dashboard router â login, all pages, /api/ask endpoint, /logout.
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { Users, Alerts, Reports, Chat } from "./db.js";
import { requireAuth, requireAdmin } from "./auth.js";
import * as views from "./views.js";
import * as hubstaff from "./hubstaff.js";
import * as ghl from "./ghl.js";
import * as claude from "./claude.js";
import { EMPLOYEES, isDispatcher, expectedShiftFor } from "./employees.js";
import { now, TZ } from "./time.js";
import { DateTime } from "luxon";
import { GpJobs, GpAttachments, GpUnmatched, GpInventory } from "./gross-profit.js";
import * as jobberSync from "./jobber-sync.js";
import * as sheets from "./sheets.js";
import * as gmail from "./gmail.js";
import fs from "fs";

// SQLite stores CURRENT_TIMESTAMP as UTC strings ("YYYY-MM-DD HH:MM:SS").
// Display them in America/New_York (Florida) so the website matches emails + clocks.
function fmtET(iso) {
  if (!iso) return "â";
  // SQLite format has no T separator; Luxon SQL parser handles it.
  const dt = String(iso).includes("T")
    ? DateTime.fromISO(iso, { zone: "utc" })
    : DateTime.fromSQL(iso, { zone: "utc" });
  if (!dt.isValid) return iso;
  return dt.setZone(TZ).toFormat("LLL d, h:mm a") + " ET";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function buildDashboardRouter() {
  const router = express.Router();

  // Static (CSS, etc.)
  router.use(
    "/styles.css",
    express.static(path.join(__dirname, "..", "public", "styles.css"))
  );

  // ===== Login =====
  router.get("/login", (req, res) => {
    if (req.session?.userId) return res.redirect("/");
    res.send(views.loginPage());
  });

  router.post("/login", express.urlencoded({ extended: false }), (req, res) => {
    const { email, password } = req.body || {};
    const user = Users.verify(email, password);
    if (!user) {
      return res.send(views.loginPage({ error: "Wrong email or password." }));
    }
    req.session.userId = user.id;
    res.redirect("/");
  });

  router.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
  });

  // ===== All routes below require login =====
  router.use(requireAuth);

  // ----- Today (home) -----
  router.get("/", async (req, res) => {
    const today = now();
    const snapshot = {
      activeNow: [],
      callsToday: 0,
      leadsToday: 0,
      alertsToday: Alerts.todayCount(),
      recentAlerts: Alerts.recent(10),
      discrepancies: [],
    };

    // Best-effort live data â failures don't break the page
    try {
      const orgUsers = await hubstaff.listOrgUsers();
      // Mark anyone whose Hubstaff "last_activity" was within ~10 min as active
      const tenMinAgo = Date.now() - 10 * 60 * 1000;
      snapshot.activeNow = orgUsers
        .filter((u) => {
          const t = new Date(u.last_activity || 0).getTime();
          return t > tenMinAgo;
        })
        .map((u) => u.name || u.email);

      // Discrepancies: scheduled today but no recent activity
      for (const e of EMPLOYEES) {
        if (!e.hubstaffEmail) continue;
        const shift = expectedShiftFor(e, today);
        if (!shift) continue;
        const hu = orgUsers.find(
          (u) => (u.email || "").toLowerCase() === e.hubstaffEmail.toLowerCase()
        );
        if (!hu) continue;
        const lastT = new Date(hu.last_activity || 0).getTime();
        if (lastT < Date.now() - 60 * 60 * 1000) {
          snapshot.discrepancies.push({
            employee: e.name,
            detail: `scheduled ${shift.start}, last activity ${
              hu.last_activity
                ? new Date(hu.last_activity).toLocaleString("en-US", {
                    timeZone: "America/New_York",
                  })
                : "never"
            }`,
          });
        }
      }
    } catch (e) {
      console.warn("[dashboard] hubstaff snapshot failed", e?.message);
    }

    res.send(views.todayPage({ user: req.user, snapshot }));
  });

  // ----- Employees -----
  router.get("/employees", async (req, res) => {
    let body = "";
    try {
      const orgUsers = await hubstaff.listOrgUsers();
      const rows = EMPLOYEES.filter((e) => e.hubstaffEmail).map((e) => {
        const hu = orgUsers.find(
          (u) => (u.email || "").toLowerCase() === e.hubstaffEmail.toLowerCase()
        );
        return `<tr>
          <td><strong>${e.name}</strong> <span class="muted">(${e.role})</span></td>
          <td>${e.hubstaffEmail}</td>
          <td>$${e.payRate}/hr</td>
          <td>${e.breakMinutesPerShift} min</td>
          <td>${hu ? "â linked" : "<span class='badge badge-amber'>not in Hubstaff</span>"}</td>
          <td class="muted">${hu?.last_activity ? new Date(hu.last_activity).toLocaleString("en-US", { timeZone: "America/New_York" }) : "â"}</td>
        </tr>`;
      }).join("");
      body = `<table class="data-table">
        <thead><tr><th>Employee</th><th>Email</th><th>Pay rate</th><th>Break/shift</th><th>Hubstaff link</th><th>Last activity</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
    } catch (e) {
      body = `<div class="banner-warn">Hubstaff data unavailable: ${e.message}</div>`;
    }
    res.send(
      views.placeholderPage({
        user: req.user,
        title: "Employees",
        navKey: "employees",
        body,
      })
    );
  });

  // ----- Dispatchers -----
  router.get("/dispatchers", async (req, res) => {
    let body = "";
    try {
      const ghlUsers = await ghl.listUsers();
      const dispatchers = EMPLOYEES.filter(isDispatcher);
      const rows = dispatchers
        .map((e) => {
          const matched = ghlUsers.find(
            (u) =>
              (u.email || "").toLowerCase() ===
              (e.ghlEmail || e.hubstaffEmail || "").toLowerCase()
          );
          return `<tr>
            <td><strong>${e.name}</strong></td>
            <td>${e.ghlEmail || e.hubstaffEmail}</td>
            <td>${matched ? "â linked" : "<span class='badge badge-amber'>not in GHL</span>"}</td>
            <td>${e.role}</td>
          </tr>`;
        })
        .join("");
      body = `<table class="data-table">
        <thead><tr><th>Dispatcher</th><th>Email</th><th>GHL link</th><th>Role</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p class="muted" style="margin-top:14px;font-size:13px">Live call counts and bookings appear in the daily reports. The most recent report is on the Reports tab.</p>`;
    } catch (e) {
      body = `<div class="banner-warn">GHL data unavailable: ${e.message}</div>`;
    }
    res.send(
      views.placeholderPage({
        user: req.user,
        title: "Dispatchers",
        navKey: "dispatchers",
        body,
      })
    );
  });

  // ----- Leads -----
  router.get("/leads", async (req, res) => {
    res.send(
      views.placeholderPage({
        user: req.user,
        title: "Leads",
        navKey: "leads",
        body: `<p class="muted">Recent leads from GoHighLevel will show here. Live alerts fire when a lead isn't contacted within 3 minutes â see the Alerts tab for that history.</p>`,
      })
    );
  });

  // ----- Alerts -----
  router.get("/alerts", (req, res) => {
    const alerts = Alerts.recent(50);
    const body =
      alerts.length === 0
        ? `<div class="empty-good">No live alerts have fired yet. The system is watching.</div>`
        : `<table class="data-table">
            <thead><tr><th>Fired at</th><th>Lead</th><th>Phone</th><th>Lead added</th><th>Elapsed</th></tr></thead>
            <tbody>${alerts
              .map(
                (a) => `<tr>
              <td class="muted">${fmtET(a.fired_at)}</td>
              <td><strong>${a.contact_name || "(unnamed)"}</strong></td>
              <td>${a.phone || "â"}</td>
              <td class="muted">${fmtET(a.lead_added_at)}</td>
              <td><span class="badge badge-red">${a.minutes_elapsed || "?"}m</span></td>
            </tr>`
              )
              .join("")}</tbody>
          </table>`;
    res.send(
      views.placeholderPage({
        user: req.user,
        title: "Live alerts",
        navKey: "alerts",
        body,
      })
    );
  });

  // ----- Reports -----
  router.get("/reports", (req, res) => {
    const reports = Reports.recent(30);
    const body =
      reports.length === 0
        ? `<p class="muted">No reports archived yet. The first morning report will land in this archive at 12:00 PM ET tomorrow.</p>`
        : `<table class="data-table">
            <thead><tr><th>Date</th><th>Type</th><th></th></tr></thead>
            <tbody>${reports
              .map(
                (r) => `<tr>
              <td>${fmtET(r.generated_at)}</td>
              <td><span class="badge badge-${r.kind === "morning" ? "manager" : "admin"}">${r.kind}</span></td>
              <td><a href="/reports/${r.id}">View report</a></td>
            </tr>`
              )
              .join("")}</tbody>
          </table>`;
    res.send(
      views.placeholderPage({
        user: req.user,
        title: "Report archive",
        navKey: "reports",
        body,
      })
    );
  });

  router.get("/reports/:id", (req, res) => {
    const report = Reports.byId(req.params.id);
    if (!report) return res.status(404).send("Report not found.");
    // Reports are stored as raw HTML â wrap in our layout
    res.send(
      views.placeholderPage({
        user: req.user,
        title: `${report.kind} report`,
        navKey: "reports",
        body: `<div class="muted" style="margin-bottom:14px">${fmtET(report.generated_at)}</div><div>${report.html_body || ""}</div>`,
      })
    );
  });

  // ----- Ask Claude -----
  router.get("/ask", (req, res) => {
    const history = Chat.recent(req.user.id, 50);
    res.send(
      views.askPage({ user: req.user, history, hasApiKey: claude.isConfigured() })
    );
  });

  router.post("/api/ask", express.json(), async (req, res) => {
    if (!claude.isConfigured()) {
      return res.json({
        error: "Anthropic API key not configured. Add ANTHROPIC_API_KEY in Render's Environment tab.",
      });
    }
    const question = (req.body?.question || "").trim();
    if (!question) return res.status(400).json({ error: "no question" });
    try {
      const history = Chat.recent(req.user.id, 20);
      Chat.append({ userId: req.user.id, role: "user", content: question });
      const answer = await claude.ask({ question, history });
      Chat.append({ userId: req.user.id, role: "assistant", content: answer });
      res.json({ answer });
    } catch (e) {
      console.error("[ask] failed", e);
      res.json({ error: e.message || "Claude request failed." });
    }
  });

  // ----- Gross Profit -----
  router.get("/gross-profit", (req, res) => {
    const jobs = GpJobs.list({ limit: 200 });
    const unmatched = GpUnmatched.list();
    const inventory = GpInventory.list();
    const status = {
      jobber: jobberSync.isConfigured(),
      sheets: sheets.isConfigured(),
      gmail: gmail.isConfigured(),
      ...sheets.status(),
      ...gmail.status(),
    };
    res.send(
      views.grossProfitPage({
        user: req.user,
        jobs, unmatched, inventory, status,
        flash: req.session.flash,
      })
    );
    delete req.session.flash;
  });

  router.get("/gross-profit/:id(\\d+)", (req, res) => {
    const job = GpJobs.byId(parseInt(req.params.id, 10));
    res.send(views.grossProfitJobPage({ user: req.user, job }));
  });

  // Serve attachment PDFs (PDFs only, served inline)
  router.get("/gross-profit/attachment/:id(\\d+)", (req, res) => {
    const att = GpAttachments.byId(parseInt(req.params.id, 10));
    if (!att) return res.status(404).send("Not found");
    try {
      const bytes = fs.readFileSync(att.storage_path);
      res.setHeader("Content-Type", att.mime_type || "application/pdf");
      res.setHeader("Content-Disposition", `inline; filename="${att.filename.replace(/"/g, "")}"`);
      res.send(bytes);
    } catch (e) {
      res.status(500).send("attachment file missing on disk");
    }
  });

  // Manual sync triggers (admin only) â useful before crons fire
  // ----- Resolve unmatched supplier invoice to a gp_jobs row -----
  router.get("/gross-profit/unmatched/:id(\\d+)/resolve", requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    const row = GpUnmatched.list().find(u => u.id === id);
    if (!row) return res.status(404).send("Unmatched row not found.");
    let candidates = [];
    if (row.po_name) candidates = GpJobs.findCandidatesByCustomer(row.po_name, { windowDays: 365, minSimilarity: 0.3 });
    const recent = GpJobs.list({ limit: 200 });
    const seen = new Set(candidates.map(c => c.row.id));
    for (const r2 of recent) if (!seen.has(r2.id)) candidates.push({ row: r2, sim: 0 });
    const esc = (s) => String(s||"").replace(/[<>"&]/g, c => ({"<":"&lt;",">":"&gt;",'"':"&quot;","&":"&amp;"}[c]));
    const candHtml = candidates.slice(0,60).map(c => {
      const sim = (c.sim*100).toFixed(0)+"%";
      const issued = c.row.jobber_invoice_issued_at || c.row.created_at || "";
      const amt = c.row.amount_paid != null ? "$"+Number(c.row.amount_paid).toLocaleString() : "&mdash;";
      const matchCell = c.sim>=0.7 ? `<strong style="color:#0a7">${sim}</strong>` : (c.sim>0 ? `<span class="muted">${sim}</span>` : "&mdash;");
      return `<tr><td>${matchCell}</td><td><strong>${esc(c.row.customer_name)}</strong></td><td class="muted">${esc(c.row.address)}</td><td class="muted">${String(issued).slice(0,10)}</td><td>${amt}</td><td><form method="post" action="/gross-profit/unmatched/${row.id}/resolve" style="margin:0"><input type="hidden" name="jobId" value="${c.row.id}"/><button class="btn">Attach to job #${c.row.id}</button></form></td></tr>`;
    }).join("");
    const pdfLink = row.attachment_id ? `<p><a href="/gross-profit/attachment/${row.attachment_id}" target="_blank">Open the PDF (new tab) &rarr;</a></p>` : "";
    const body = `<div class="page-head"><h1>Resolve unmatched invoice</h1><span class="page-sub">${esc(row.supplier)} &middot; ${esc(row.po_name||"(no PO parsed)")} &middot; ${row.total_amount!=null?"$"+Number(row.total_amount).toLocaleString():"(no total)"}</span></div>${pdfLink}<p class="muted">Pick the job this invoice belongs to. Sorted by similarity. Greens (>=70%) are likely matches.</p><table class="data-table"><thead><tr><th>Match</th><th>Customer</th><th>Address</th><th>Issued</th><th>Paid</th><th></th></tr></thead><tbody>${candHtml||"<tr><td colspan=6 class='muted'>No candidates.</td></tr>"}</tbody></table><p style="margin-top:18px"><a href="/gross-profit">&larr; back to Gross Profit</a></p>`;
    res.send(views.placeholderPage({ user: req.user, title: "Resolve unmatched invoice", navKey: "gross-profit", body }));
  });

  router.post("/gross-profit/unmatched/:id(\\d+)/resolve", requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const jobId = parseInt((req.body || {}).jobId, 10);
    try {
      const u = GpUnmatched.list().find(x => x.id === id);
      if (!u) throw new Error("unmatched row no longer exists");
      if (!Number.isFinite(jobId)) throw new Error("missing jobId");
      const att = u.attachment_id ? GpAttachments.byId(u.attachment_id) : null;
      let parsed = {};
      if (att && att.metadata_json) { try { parsed = JSON.parse(att.metadata_json).parsed || {}; } catch {} }
      if (att) {
        GpJobs.applySupplierInvoice(jobId, { equipmentCost: parsed.equipment || 0, materialsCost: parsed.materials || 0, totalWithTax: parsed.total || u.total_amount || 0 }, { attachmentId: att.id });
      }
      GpUnmatched.resolve(id, jobId);
      req.session.flash = { type: "ok", message: `Attached invoice to job #${jobId}.` };
    } catch (e) {
      req.session.flash = { type: "error", message: `Resolve failed: ${e.message}` };
    }
    res.redirect("/gross-profit");
  });

  // Gmail recon — search the inbox with an arbitrary query, return from+subject samples.
  router.get("/gross-profit/debug/gmail-search", requireAdmin, async (req, res) => {
    try {
      const q = (req.query.q || "").trim();
      if (!q) return res.json({ err: "pass ?q=<gmail-search-query>" });
      const fs2 = await import("fs");
      const credsRaw = process.env.GOOGLE_SA_JSON || fs2.readFileSync("/etc/secrets/google-sa.json", "utf8");
      const creds = JSON.parse(credsRaw);
      const { google } = await import("googleapis");
      const users = (process.env.GMAIL_DELEGATED_USERS || process.env.GMAIL_DELEGATED_USER || "").split(",").map(s=>s.trim()).filter(Boolean);
      const out = {};
      for (const u of users) {
        const auth = new google.auth.JWT({ email: creds.client_email, key: creds.private_key, scopes: ["https://www.googleapis.com/auth/gmail.readonly"], subject: u });
        await auth.authorize();
        const g = google.gmail({ version: "v1", auth });
        const list = await g.users.messages.list({ userId: "me", q, maxResults: 50 });
        const msgs = list.data.messages || [];
        const samples = [];
        for (const m of msgs.slice(0, 30)) {
          const det = await g.users.messages.get({ userId: "me", id: m.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
          const h = Object.fromEntries((det.data.payload?.headers || []).map(x => [x.name, x.value]));
          samples.push({ from: h.From, subject: h.Subject, date: h.Date });
        }
        out[u] = { count: msgs.length, samples };
      }
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/gross-profit/sync/jobber", requireAdmin, async (req, res) => {
    try {
      const r = await jobberSync.pollOnce();
      req.session.flash = { type: "ok", message: `Jobber sync: ${JSON.stringify(r)}` };
    } catch (e) {
      req.session.flash = { type: "error", message: `Jobber sync failed: ${e.message}` };
    }
    res.redirect("/gross-profit");
  });
  // Backfill: pull every Jobber invoice issued on/after a given date.
  // Defaults to Jan 1 of the current year.
  router.post("/gross-profit/sync/backfill", requireAdmin, async (req, res) => {
    const since = (req.body?.since || `${new Date().getFullYear()}-01-01`).trim();
    try {
      const r = await jobberSync.backfillSince(since);
      req.session.flash = { type: "ok", message: `Backfill since ${since}: ${JSON.stringify(r)}` };
    } catch (e) {
      req.session.flash = { type: "error", message: `Backfill failed: ${e.message}` };
    }
    res.redirect("/gross-profit");
  });
  router.post("/gross-profit/sync/sheets", requireAdmin, async (req, res) => {
    try {
      const r = await sheets.scanChrisSheet();
      req.session.flash = { type: "ok", message: `Sheets scan: ${JSON.stringify(r)}` };
    } catch (e) {
      req.session.flash = { type: "error", message: `Sheets scan failed: ${e.message}` };
    }
    res.redirect("/gross-profit");
  });
  router.post("/gross-profit/sync/gmail", requireAdmin, async (req, res) => {
    try {
      const r = await gmail.pollOnce();
      req.session.flash = { type: "ok", message: `Gmail watcher: ${JSON.stringify(r)}` };
    } catch (e) {
      req.session.flash = { type: "error", message: `Gmail watcher failed: ${e.message}` };
    }
    res.redirect("/gross-profit");
  });
  router.post("/gross-profit/sync/mirror", requireAdmin, async (req, res) => {
    try {
      const r = await sheets.syncMirror();
      req.session.flash = { type: "ok", message: `Mirror sync: ${JSON.stringify(r)}` };
    } catch (e) {
      req.session.flash = { type: "error", message: `Mirror sync failed: ${e.message}` };
    }
    res.redirect("/gross-profit");
  });

  // ----- GHL diagnostic probe (admin only) -----
  // Hits several GHL endpoints and returns raw responses so we can see
  // exactly why the calls report shows zero. Safe to leave in place.
  router.get("/admin/ghl-debug", requireAdmin, async (req, res) => {
    try {
      const out = await ghl.probe();
      res.setHeader("Content-Type", "application/json");
      res.send(JSON.stringify(out, null, 2));
    } catch (e) {
      res.status(500).send(`probe failed: ${e.message}`);
    }
  });

  // ----- Settings/Users (admin only) -----
  router.get("/settings/users", requireAdmin, (req, res) => {
    res.send(
      views.usersPage({
        user: req.user,
        users: Users.list(),
        flash: req.session.flash,
      })
    );
    delete req.session.flash;
  });

  router.post(
    "/settings/users",
    requireAdmin,
    express.urlencoded({ extended: false }),
    (req, res) => {
      const { email, name, password, role } = req.body || {};
      try {
        if (!email || !password || password.length < 8) {
          throw new Error("Email and password (min 8 chars) required.");
        }
        if (Users.findByEmail(email)) throw new Error("Email already exists.");
        Users.create({ email, name, password, role: role === "admin" ? "admin" : "manager" });
        req.session.flash = { type: "ok", message: `User ${email} created.` };
      } catch (e) {
        req.session.flash = { type: "error", message: e.message };
      }
      res.redirect("/settings/users");
    }
  );

  // ----- Admin: gmail processed-emails debug -----
  // Shows count of gp_processed_emails by outcome, and most recent rows.
  // Helps diagnose why a poll returned processed:0 â were all messages
  // already-processed (dedup) or filtered out by subject rules?
  router.get("/gross-profit/debug/gmail", requireAdmin, async (req, res) => {
    try {
      const { db } = await import("./db.js");
      const byOutcome = db.prepare(
        `SELECT outcome, COUNT(*) AS n FROM gp_processed_emails GROUP BY outcome`
      ).all();
      const recent = db.prepare(
        `SELECT message_id, from_addr, subject, outcome, notes, received_at
           FROM gp_processed_emails
          ORDER BY id DESC LIMIT 30`
      ).all();
      const skippedSamples = db.prepare(
        `SELECT subject, notes FROM gp_processed_emails
          WHERE outcome = 'skipped' ORDER BY id DESC LIMIT 30`
      ).all();
      const errorSamples = db.prepare(
        `SELECT message_id, notes FROM gp_processed_emails
          WHERE outcome = 'error' ORDER BY id DESC LIMIT 30`
      ).all();
      res.json({ byOutcome, recent, skippedSamples, errorSamples });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // ----- Admin: rescan with subject/dedup ladder cleared -----
  // Removes 'skipped' rows from gp_processed_emails (so a re-poll re-evaluates
  // them under the current filters) without touching matched/unmatched/error
  // rows. SHA-256 + applied_at dedup still prevents double-counting costs.
  router.post("/gross-profit/debug/rescan-skipped", requireAdmin, async (req, res) => {
    try {
      const { db } = await import("./db.js");
      const before = db.prepare(`SELECT COUNT(*) AS n FROM gp_processed_emails WHERE outcome='skipped'`).get().n;
      db.prepare(`DELETE FROM gp_processed_emails WHERE outcome='skipped'`).run();
      const after = db.prepare(`SELECT COUNT(*) AS n FROM gp_processed_emails WHERE outcome='skipped'`).get().n;
      res.json({ deletedSkipped: before, remaining: after });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- Admin: manual triggers for cron jobs (idle/morning/evening) -----
  // Lets us fire the same code paths the cron schedules use, without
  // waiting for the actual cron. Returns JSON with timing + any error message.
  router.get("/admin/run/idle-check", requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      const idle = await import("./idle.js");
      await idle.checkIdleDispatchers();
      res.json({ ok: true, kind: "idle-check", durationMs: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, kind: "idle-check", error: e?.message, stack: e?.stack });
    }
  });

  router.get("/admin/run/morning-report", requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      const reports = await import("./reports.js");
      await reports.runMorningReport();
      res.json({ ok: true, kind: "morning-report", durationMs: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, kind: "morning-report", error: e?.message, stack: e?.stack });
    }
  });

  router.get("/admin/run/evening-report", requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      const reports = await import("./reports.js");
      await reports.runEveningReport();
      res.json({ ok: true, kind: "evening-report", durationMs: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, kind: "evening-report", error: e?.message, stack: e?.stack });
    }
  });

  return router;
}
