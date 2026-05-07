// Dashboard router ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ login, all pages, /api/ask endpoint, /logout.
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
  if (!iso) return "ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ";
  // SQLite format has no T separator; Luxon SQL parser handles it.
  const dt = String(iso).includes("T")
    ? DateTime.fromISO(iso, { zone: "utc" })
    : DateTime.fromSQL(iso, { zone: "utc" });
  if (!dt.isValid) return iso;
  return dt.setZone(TZ).toFormat("LLL d, h:mm a") + " ET";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


// Filter for installs only â excludes $0 invoices (warranty/recall/service)
// and the "Local AC LLC" test row. Used on the Gross Profit page; future
// pages for warranty/recall will display the excluded rows.
function isInstall(j) {
  const amt = Math.max(Number(j.amount_paid) || 0, Number(j.invoice_total) || 0);
  if (amt <= 0) return false;
  const name = String(j.customer_name || '').toLowerCase().trim();
  if (name === 'local ac llc' || name === 'local ac') return false;
  return true;
}

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

    // Best-effort live data ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ failures don't break the page
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
          <td>${hu ? "ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ linked" : "<span class='badge badge-amber'>not in Hubstaff</span>"}</td>
          <td class="muted">${hu?.last_activity ? new Date(hu.last_activity).toLocaleString("en-US", { timeZone: "America/New_York" }) : "ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ"}</td>
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
            <td>${matched ? "ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ linked" : "<span class='badge badge-amber'>not in GHL</span>"}</td>
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
        body: `<p class="muted">Recent leads from GoHighLevel will show here. Live alerts fire when a lead isn't contacted within 3 minutes ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ see the Alerts tab for that history.</p>`,
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
              <td>${a.phone || "ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ"}</td>
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
    // Reports are stored as raw HTML ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ wrap in our layout
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
    // Date-range filtering. Accepts:
    //   ?preset=jan-2026 | feb-2026 | ... | year | last-30 | last-90 | all
    //   ?from=YYYY-MM-DD&to=YYYY-MM-DD  (custom range; overrides preset)
    const preset = String(req.query.preset || "all").toLowerCase();
    let from = req.query.from || null;
    let to = req.query.to || null;
    if (!from && !to) {
      const today = new Date();
      const yyyymm = (y, m) => `${y}-${String(m + 1).padStart(2, "0")}`;
      const monthRange = (y, m) => {
        const first = `${yyyymm(y, m)}-01`;
        const last = new Date(y, m + 1, 0); // last day of month
        return [first, `${yyyymm(y, m)}-${String(last.getDate()).padStart(2, "0")}`];
      };
      const months2026 = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
      const mIdx = months2026.indexOf(preset.replace("-2026", "").trim());
      if (mIdx >= 0 && preset.endsWith("2026")) {
        [from, to] = monthRange(2026, mIdx);
      } else if (preset === "year") {
        from = `${today.getFullYear()}-01-01`;
        to = `${today.getFullYear()}-12-31`;
      } else if (preset === "last-30") {
        const d = new Date(today); d.setDate(d.getDate() - 30);
        from = d.toISOString().slice(0, 10);
        to = today.toISOString().slice(0, 10);
      } else if (preset === "last-90") {
        const d = new Date(today); d.setDate(d.getDate() - 90);
        from = d.toISOString().slice(0, 10);
        to = today.toISOString().slice(0, 10);
      }
      // preset === "all" ÃÂÃÂ¢ÃÂÃÂÃÂÃÂ leave from/to null
    }
    const filter = { from, to };
    let jobs = GpJobs.list({ limit: 5000, ...filter }).filter(isInstall);
    const totalCount = jobs.length;
    const totalPaid = jobs.reduce((s, j) => s + (Number(j.amount_paid) || 0), 0);
    const grandTotalCount = GpJobs.list({ limit: 5000 }).filter(isInstall).length;
    const summary = GpJobs.qualifiedSummary(filter);
    if (summary && typeof summary === "object") summary.total = jobs.length;
    const totalInvoiced = jobs.reduce((s, j) => s + (Number(j.invoice_total) || 0), 0);
    const totalDue = Math.max(0, totalInvoiced - totalPaid);
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
        filter: { ...filter, preset },
        totalCount, totalPaid, totalInvoiced, totalDue, grandTotalCount,
        summary,
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

  // Manual sync triggers (admin only) ÃÂÃÂÃÂÃÂ¢ÃÂÃÂÃÂÃÂÃÂÃÂÃÂÃÂ useful before crons fire
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
        Users.create({ email, name, password, role: role === "admin" ? "admin" : "manager" });
        req.session.flash = { type: "ok", message: `User ${email} created.` };
      } catch (e) {
        req.session.flash = { type: "error", message: e.message };
      }
      res.redirect("/settings/users");
    }
  );

  return router;
}
