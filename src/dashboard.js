// Dashboard router — login, all pages, /api/ask endpoint, /logout.
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
import { checkIdleDispatchers } from "./idle.js";
import { runMorningReport, runEveningReport } from "./reports.js";
import { _internal as alertsInternal } from "./alerts.js";

// SQLite stores CURRENT_TIMESTAMP as UTC strings ("YYYY-MM-DD HH:MM:SS").
// Display them in America/New_York (Florida) so the website matches emails + clocks.
function fmtET(iso) {
  if (!iso) return "—";
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
      // Pre-format alert timestamps in ET so the Today widget doesn't show raw UTC
      recentAlerts: Alerts.recent(10).map((a) => ({
        ...a,
        fired_at_display: fmtET(a.fired_at),
        lead_added_display: fmtET(a.lead_added_at),
      })),
      discrepancies: [],
    };

    // Best-effort live data — failures don't break the page
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

      // Discrepancies: only flag people whose shift is CURRENTLY in progress
      // but who have no recent Hubstaff activity. Skip anyone whose shift
      // hasn't started yet OR has already ended — those aren't discrepancies.
      const nowDt = today; // Luxon DateTime in ET
      for (const e of EMPLOYEES) {
        if (!e.hubstaffEmail) continue;
        const shift = expectedShiftFor(e, today);
        if (!shift) continue;
        // Parse shift start/end as Luxon DateTimes for today
        const [sh, sm] = shift.start.split(":").map(Number);
        const [eh, em] = shift.end.split(":").map(Number);
        const shiftStart = nowDt.set({ hour: sh, minute: sm, second: 0, millisecond: 0 });
        const shiftEnd = nowDt.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
        // Skip if shift hasn't started or already ended
        if (nowDt < shiftStart || nowDt > shiftEnd) continue;
        const hu = orgUsers.find(
          (u) => (u.email || "").toLowerCase() === e.hubstaffEmail.toLowerCase()
        );
        if (!hu) continue;
        const lastT = new Date(hu.last_activity || 0).getTime();
        if (lastT < Date.now() - 60 * 60 * 1000) {
          // Format times nicely (12-hour AM/PM)
          const fmtHHMM = (hhmm) => {
            const [h, m] = hhmm.split(":").map(Number);
            const ampm = h < 12 ? "AM" : "PM";
            const h12 = h % 12 === 0 ? 12 : h % 12;
            return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
          };
          const lastActivityDisplay = hu.last_activity
            ? DateTime.fromISO(hu.last_activity)
                .setZone(TZ)
                .toFormat("LLL d, h:mm a") + " ET"
            : "never";
          snapshot.discrepancies.push({
            employee: e.name,
            detail: `scheduled ${fmtHHMM(shift.start)}–${fmtHHMM(shift.end)}, last activity ${lastActivityDisplay}`,
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
          <td>${hu ? "✓ linked" : "<span class='badge badge-amber'>not in Hubstaff</span>"}</td>
          <td class="muted">${hu?.last_activity ? new Date(hu.last_activity).toLocaleString("en-US", { timeZone: "America/New_York" }) : "—"}</td>
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
            <td>${matched ? "✓ linked" : "<span class='badge badge-amber'>not in GHL</span>"}</td>
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
        body: `<p class="muted">Recent leads from GoHighLevel will show here. Live alerts fire when a lead isn't contacted within 3 minutes — see the Alerts tab for that history.</p>`,
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
              <td>${a.phone || "—"}</td>
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
    // Reports are stored as raw HTML — wrap in our layout
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

  // ===== Admin: manual triggers (test-on-demand for the cron jobs) =====
  // Lets Alex run any of the schedulers ad-hoc to verify they work without
  // waiting for the actual cron. Returns JSON with timing + any error message.
  router.get("/admin/run/idle-check", requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      await checkIdleDispatchers();
      res.json({ ok: true, kind: "idle-check", durationMs: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, kind: "idle-check", error: e?.message, stack: e?.stack });
    }
  });

  router.get("/admin/run/morning-report", requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      await runMorningReport();
      res.json({ ok: true, kind: "morning-report", durationMs: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, kind: "morning-report", error: e?.message, stack: e?.stack });
    }
  });

  router.get("/admin/run/evening-report", requireAdmin, async (req, res) => {
    const t0 = Date.now();
    try {
      await runEveningReport();
      res.json({ ok: true, kind: "evening-report", durationMs: Date.now() - t0 });
    } catch (e) {
      res.status(500).json({ ok: false, kind: "evening-report", error: e?.message, stack: e?.stack });
    }
  });

  // Debug: dump everything alerts.js can see for a given contact (by phone
  // OR contactId). Used to diagnose false-positive alerts. Strips PII-heavy
  // fields but returns enough to trace exactly why an alert did/didn't fire.
  //
  //   /admin/debug/contact?phone=+13157976111   (requires URL-encoded +)
  //   /admin/debug/contact?phone=13157976111
  //   /admin/debug/contact?contactId=abc123
  //   /admin/debug/contact?phone=...&since=2026-05-07T15:26:00Z
  //                                       ^^^^^ leadAddedAt to test against
  router.get("/admin/debug/contact", requireAdmin, async (req, res) => {
    try {
      const { phone, contactId, since } = req.query;
      let resolvedContactId = contactId;
      let contact = null;

      if (!resolvedContactId && phone) {
        // Use the ghl client (already has correct PIT auth + Version header)
        const matches = await ghl.searchContactsByPhone(phone);
        if (matches.length === 0) {
          return res.json({ ok: false, error: `no contact found for phone ${phone}` });
        }
        contact = matches[0];
        resolvedContactId = contact.id;
      } else if (resolvedContactId) {
        contact = await ghl.getContact(resolvedContactId).catch(() => null);
      }

      if (!resolvedContactId) {
        return res.status(400).json({ ok: false, error: "Provide ?phone= or ?contactId=" });
      }

      // Now pull conversations + messages + notes via the same path alerts.js uses
      const conversations = await ghl.getConversationsByContactId(resolvedContactId).catch(() => []);
      const messagesPerConv = [];
      for (const c of conversations) {
        const m = await ghl.getConversationMessages(c.id).catch(() => []);
        messagesPerConv.push({
          conversationId: c.id,
          dateAdded: c.dateAdded,
          lastMessageDate: c.lastMessageDate,
          messageCount: m.length,
          messages: m.map((msg) => ({
            id: msg.id,
            type: msg.type,
            messageType: msg.messageType,
            direction: msg.direction,
            userId: msg.userId,
            dateAdded: msg.dateAdded,
            duration: msg.meta?.call?.duration ?? msg.callDuration ?? msg.duration ?? null,
            status: msg.meta?.call?.status ?? null,
            bodyPreview: (msg.body || "").slice(0, 80),
          })),
        });
      }
      const notes = await ghl.getContactNotes(resolvedContactId).catch(() => []);

      // Run the actual alerts.js logic to see what it would conclude
      const leadAddedAt = since || contact?.dateAdded || new Date().toISOString();
      const summary = await alertsInternal.getCallSummary(resolvedContactId, leadAddedAt);

      res.json({
        ok: true,
        contact: contact ? {
          id: contact.id,
          name: contact.contactName || `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
          phone: contact.phone,
          dateAdded: contact.dateAdded,
        } : null,
        leadAddedAt,
        conversations: messagesPerConv,
        notes: (notes || []).map((n) => ({
          id: n.id,
          userId: n.userId,
          dateAdded: n.dateAdded,
          bodyPreview: (n.body || "").slice(0, 200),
          isVonageCallNote: /^\s*called\b/i.test(String(n.body || "")),
        })),
        alertsConclusion: summary,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
    }
  });

  return router;
}
