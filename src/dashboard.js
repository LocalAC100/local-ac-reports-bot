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
import { GpJobs, GpAttachments, GpUnmatched } from "./gross-profit.js";
import * as gmail from "./gmail.js";
import { buildAggregatedReport, resolveRange } from "./aggregate.js";
import { sendMail } from "./mailer.js";
import { config } from "./config.js";

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
  router.get("/sales", (req, res) => {
    res.send(views.placeholderPage({
      user: req.user,
      title: "Sales",
      navKey: "sales",
      body: '<iframe src="/admin/jobber/wh/sales/lac-jwt-2026-bootstrap-axabramov" style="width:100%;height:calc(100vh - 150px);border:none"></iframe>',
    }));
  });

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

  // ----- Dispatch (formerly Reports) -----
  // Default landing: Daily mode, yesterday's date (closing is 9 PM ET so
  // the report is ready every morning for the prior day).
  router.get("/dispatch", async (req, res) => {
    const today = now();
    const yesterday = today.minus({ days: 1 }).toFormat("yyyy-LL-dd");
    const mode = (req.query.mode || "daily").toLowerCase();
    const validModes = ["daily", "weekly", "monthly", "custom"];
    const safeMode = validModes.includes(mode) ? mode : "daily";

    let bodyContent = "";
    let titleSuffix = "";

    if (safeMode === "daily") {
      const date = req.query.date || yesterday;
      bodyContent = await renderDailyView(date);
      titleSuffix = ` — ${date}`;
    } else {
      // weekly / monthly / custom — try to load cached aggregated report
      let range;
      try {
        range = resolveRange({
          mode: safeMode,
          date: req.query.date,
          from: req.query.from,
          to: req.query.to,
          month: req.query.month,
        });
      } catch (e) {
        bodyContent = `<p class="muted">Invalid date range: ${escapeHtml(e.message)}</p>`;
        range = null;
      }
      if (range) {
        const cacheKey = aggCacheKey(safeMode, range.from, range.to);
        const cached = ReportsByKind(cacheKey);
        if (cached) {
          bodyContent = `<div class="muted" style="margin-bottom:14px">Cached at ${fmtET(cached.generated_at)} — click <b>Real-time report</b> to refresh.</div><div>${cached.html_body || ""}</div>`;
        } else {
          bodyContent = `<p class="muted">No cached report for this range yet. Click <b>Real-time report</b> below to generate one and email it to ${escapeHtml(config.recipient || "the reports inbox")}.</p>`;
        }
        titleSuffix = ` — ${range.from.toFormat("LLL d")}${
          safeMode === "daily" ? "" : ` → ${range.to.toFormat("LLL d")}`
        }`;
      }
    }

    const body = renderDispatchPage({
      mode: safeMode,
      query: req.query,
      yesterday,
      bodyContent,
    });

    res.send(
      views.layout({
        title: `Dispatch${titleSuffix}`,
        user: req.user,
        activeNav: "dispatch",
        body,
      })
    );
  });

  // View an individual archived report (by DB id). Linked from the archive list.
  router.get("/dispatch/report/:id", (req, res) => {
    const report = Reports.byId(req.params.id);
    if (!report) return res.status(404).send("Report not found.");
    res.send(
      views.layout({
        title: `${report.kind} report`,
        user: req.user,
        activeNav: "dispatch",
        body: `<div class="page-head"><h1>${escapeHtml(report.kind)} report</h1><a href="/dispatch" style="font-size:13px">&larr; back to Dispatch</a></div>
          <section class="panel">
            <div class="muted" style="margin-bottom:14px">${fmtET(report.generated_at)}</div>
            <div>${report.html_body || ""}</div>
          </section>`,
      })
    );
  });

  // Real-time generation endpoint. POST so it's not triggered by accidental
  // GETs / link-prefetching. Body: { mode, date?, from?, to?, month? }.
  router.post("/dispatch/generate", express.json(), async (req, res) => {
    const t0 = Date.now();
    const { mode, date, from, to, month } = req.body || {};
    const safeMode = ["daily", "weekly", "monthly", "custom"].includes(mode)
      ? mode
      : "daily";
    try {
      if (safeMode === "daily") {
        const targetDate =
          date || now().minus({ days: 1 }).toFormat("yyyy-LL-dd");
        // runEveningReport already archives in reports_history + emails.
        await runEveningReport({ dateOverride: targetDate, noMail: !(req.body && req.body.email) });
        return res.json({
          ok: true,
          mode: "daily",
          date: targetDate,
          durationMs: Date.now() - t0,
        });
      }
      const range = resolveRange({ mode: safeMode, date, from, to, month });
      const generatedAt = now();
      const { html, summary } = await buildAggregatedReport({
        mode: safeMode,
        from: range.from,
        to: range.to,
        generatedAt,
      });
      const cacheKey = aggCacheKey(safeMode, range.from, range.to);
      try {
        Reports.log({ kind: cacheKey, html, summary });
      } catch (e) {
        console.error("[dispatch] archive failed:", e?.message);
      }
      const subject = `Local AC — ${safeMode[0].toUpperCase()}${safeMode.slice(1)} Dispatch (${range.from.toFormat("LLL d")} → ${range.to.toFormat("LLL d")})`;
      if (req.body && req.body.email) await sendMail({ subject, html });
      return res.json({
        ok: true,
        mode: safeMode,
        from: range.from.toISO(),
        to: range.to.toISO(),
        cacheKey,
        durationMs: Date.now() - t0,
      });
    } catch (e) {
      console.error("[dispatch] generate failed:", e);
      return res.status(500).json({
        ok: false,
        mode: safeMode,
        error: e?.message,
      });
    }
  });

  // Backward-compat: redirect old /reports URLs (which may live in archived
  // emails) to /dispatch.
  router.get("/reports", (req, res) => res.redirect(301, "/dispatch"));
  router.get("/reports/:id", (req, res) =>
    res.redirect(301, `/dispatch/report/${req.params.id}`)
  );

  // --- helpers (scoped to this router so they share Reports, fmtET, now, etc.) ---
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function aggCacheKey(mode, from, to) {
    const f = from.setZone(TZ).toFormat("yyyy-LL-dd");
    const t = to.setZone(TZ).toFormat("yyyy-LL-dd");
    return `${mode}:${f}:${t}`;
  }

  function ReportsByKind(kind) {
    // Latest report with the given kind string. Returns the full row or null.
    const rows = db_select_reports_by_kind(kind);
    return rows.length ? rows[0] : null;
  }

  // Pull the latest daily archived report whose generated_at falls on the given
  // ET calendar date. Prefer "evening" (full-day) over "morning" (snapshot).
  function latestDailyReportFor(dateStr) {
    // ET calendar day window converted to UTC for the SQL comparison.
    const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
    const dayEnd = dayStart.endOf("day");
    const utcStart = dayStart.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
    const utcEnd = dayEnd.toUTC().toFormat("yyyy-LL-dd HH:mm:ss");
    const rows = db_select_reports_in_window(utcStart, utcEnd);
    if (!rows.length) return null;
    // Prefer evening, then morning, then anything else.
    const evening = rows.find((r) => r.kind === "evening");
    if (evening) return evening;
    const morning = rows.find((r) => r.kind === "morning");
    if (morning) return morning;
    return rows[0];
  }

  async function renderDailyView(dateStr) {
    const report = latestDailyReportFor(dateStr);
    if (!report) {
      return `<p class="muted">No archived report for <b>${escapeHtml(dateStr)}</b>. Click <b>Real-time report</b> to generate one and email it.</p>`;
    }
    return `<div class="muted" style="margin-bottom:14px">${escapeHtml(report.kind)} report — generated ${fmtET(report.generated_at)}</div>
      <div>${report.html_body || ""}</div>`;
  }

  function renderDispatchPage({ mode, query, yesterday, bodyContent }) {
    const monthValue =
      query.month ||
      (mode === "monthly"
        ? now().minus({ months: 0 }).toFormat("yyyy-LL")
        : "");
    const dateValue =
      query.date ||
      (mode === "monthly" ? "" : yesterday);
    const fromValue = query.from || yesterday;
    const toValue = query.to || yesterday;

    const tab = (key, label) =>
      `<a href="/dispatch?mode=${key}" class="dispatch-tab ${mode === key ? "active" : ""}">${label}</a>`;

    // Dynamic pickers depending on mode
    let pickerHtml = "";
    if (mode === "daily") {
      pickerHtml = `<label style="font-size:13px">Date
        <input type="date" name="date" value="${escapeHtml(dateValue)}" max="${escapeHtml(now().toFormat("yyyy-LL-dd"))}" />
      </label>`;
    } else if (mode === "weekly") {
      pickerHtml = `<label style="font-size:13px">Week ending
        <input type="date" name="date" value="${escapeHtml(dateValue)}" max="${escapeHtml(now().toFormat("yyyy-LL-dd"))}" />
      </label>
      <div style="font-size:12px;color:#7a8294;align-self:end;padding-bottom:9px">7-day window ending on selected date.</div>`;
    } else if (mode === "monthly") {
      pickerHtml = `<label style="font-size:13px">Month
        <input type="month" name="month" value="${escapeHtml(monthValue)}" max="${escapeHtml(now().toFormat("yyyy-LL"))}" />
      </label>`;
    } else if (mode === "custom") {
      pickerHtml = `<label style="font-size:13px">From
        <input type="date" name="from" value="${escapeHtml(fromValue)}" max="${escapeHtml(now().toFormat("yyyy-LL-dd"))}" />
      </label>
      <label style="font-size:13px">To
        <input type="date" name="to" value="${escapeHtml(toValue)}" max="${escapeHtml(now().toFormat("yyyy-LL-dd"))}" />
      </label>`;
    }

    const styles = `<style>
      .dispatch-tabs { display:flex; gap:4px; margin-bottom:18px; border-bottom:1px solid #e0e6ee; }
      .dispatch-tab { padding:10px 16px; text-decoration:none; color:#5a6376; font-weight:600; font-size:14px;
        border-bottom:2px solid transparent; margin-bottom:-1px; transition:all 0.15s; }
      .dispatch-tab:hover { color:#1B57A8; }
      .dispatch-tab.active { color:#1B57A8; border-bottom-color:#1B57A8; }
      .dispatch-controls { display:flex; flex-wrap:wrap; gap:14px; align-items:end; margin-bottom:14px; padding:14px;
        background:#f5f7fb; border-radius:8px; }
      .dispatch-controls input[type=date], .dispatch-controls input[type=month] {
        padding:8px 10px; border:1px solid #d6dbe5; border-radius:6px; font-size:14px; }
      .dispatch-report { padding:8px 0; }
      #rt-status { margin-left:12px; font-size:13px; color:#5a6376; }
    
  /* On-screen polish (sales-style) — page only, not in the emailed report */
  .dispatch-report{ max-width:1000px; margin:0 auto; }
  .dispatch-report table{ border-collapse:collapse !important; width:100% !important; font-size:12.5px !important; }
  .dispatch-report th, .dispatch-report td{ padding:7px 9px !important; }
  .dispatch-report h2, .dispatch-report h3{ margin-top:22px; }
</style>`;

    const script = `<script>
      (function(){
        var btn = document.getElementById('rt-btn');
        if (!btn) return;
        btn.addEventListener('click', async function(){
          var status = document.getElementById('rt-status');
          btn.disabled = true;
          status.textContent = 'Generating…';
          var mode = ${JSON.stringify(mode)};
          var body = { mode: mode };
          var form = document.getElementById('dispatch-form');
          var fd = new FormData(form);
          for (var pair of fd.entries()) { body[pair[0]] = pair[1]; }
          body.email = window.__dispEmail ? 1 : 0; window.__dispEmail = false;
          try {
            var r = await fetch('/dispatch/generate', {
              method:'POST',
              headers:{'Content-Type':'application/json'},
              body: JSON.stringify(body)
            });
            var j = await r.json();
            if (!j.ok) throw new Error(j.error || 'Generation failed');
            status.textContent = 'Done in ' + Math.round((j.durationMs||0)/1000) + 's. Reloading…';
            setTimeout(function(){ location.reload(); }, 600);
          } catch (e) {
            status.textContent = 'Error: ' + e.message;
            btn.disabled = false;
          }
        });
      })();
    </script>`;

    return `${styles}
    <div class="page-head">
      <h1>Dispatch</h1>
      <span class="page-sub" style="font-size:13px;color:#7a8294">Daily, weekly, monthly, and custom-range views of dispatcher and lead activity.</span>
    </div>
    <section class="panel">
      <nav class="dispatch-tabs">
        ${tab("daily", "Daily")}
        ${tab("weekly", "Weekly")}
        ${tab("monthly", "Monthly")}
        ${tab("custom", "Custom")}
      </nav>
      <form id="dispatch-form" class="dispatch-controls" method="get" action="/dispatch">
        <input type="hidden" name="mode" value="${escapeHtml(mode)}" />
        ${pickerHtml}
        <button type="submit" class="btn btn-primary" style="height:38px">View</button>
        <button type="button" id="rt-btn" class="btn btn-primary" style="height:38px;background:#138a36">Run report</button>
        <button type="button" id="rt-email-btn" class="btn btn-primary" style="height:36px;background:#1a7a3c" onclick="window.__dispEmail=true;document.getElementById('rt-btn').click();">Email report</button>
        <span id="rt-status"></span>
      </form>
      <div class="dispatch-report">${bodyContent}</div>
    </section>
    ${script}`;
  }

  // SQLite query helpers. We dip into the same `db` better-sqlite3 handle that
  // db.js opened — but it's not exported. Instead use Reports.* and a small
  // raw query via a fresh prepare on the existing connection through Reports.
  // The cleanest path is to add tiny readers to db.js, but to keep this PR
  // contained we go through Reports.recent() and filter client-side.
  function db_select_reports_by_kind(kind) {
    // recent(N) is plenty for cache lookup; cache keys are unique per range.
    const all = Reports.recent(500);
    return all
      .filter((r) => r.kind === kind)
      .map((r) => Reports.byId(r.id))
      .filter(Boolean);
  }

  function db_select_reports_in_window(utcStart, utcEnd) {
    const all = Reports.recent(500);
    return all
      .filter((r) => {
        const ts = String(r.generated_at || "");
        return ts >= utcStart && ts <= utcEnd;
      })
      .map((r) => Reports.byId(r.id))
      .filter(Boolean);
  }

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

  // ----- Admin: rescan with subject/dedup ladder cleared -----
  router.post("/gross-profit/debug/rescan-skipped", requireAdmin, async (req, res) => {
    try {
      const { db } = await import("./db.js");
      const before = db.prepare("SELECT COUNT(*) AS n FROM gp_processed_emails WHERE outcome='skipped'").get().n;
      db.prepare("DELETE FROM gp_processed_emails WHERE outcome='skipped'").run();
      res.json({ deletedSkipped: before });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ----- Admin: gmail processed-emails debug -----
  router.get("/gross-profit/debug/gmail", requireAdmin, async (req, res) => {
    try {
      const { db } = await import("./db.js");
      const byOutcome = db.prepare("SELECT outcome, COUNT(*) AS n FROM gp_processed_emails GROUP BY outcome").all();
      const recent = db.prepare("SELECT message_id, from_addr, subject, outcome, notes, received_at FROM gp_processed_emails ORDER BY id DESC LIMIT 30").all();
      res.json({ byOutcome, recent });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // ----- Admin: re-parse all unmatched supplier invoices using new body-PO extractor -----
  router.post("/gross-profit/debug/reparse-unmatched", requireAdmin, async (req, res) => {
    try {
      const r = await gmail.reparseUnmatched({ limit: parseInt(req.query.limit, 10) || 500 });
      res.json(r);
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });

  // ----- Manual attach: GET shows ranked candidate jobs for a Gemaire/Goodman/HD invoice -----
  router.get("/gross-profit/unmatched/:id(\\d+)/resolve", async (req, res) => {
    try {
      const { db } = await import("./db.js");
      const um = db.prepare("SELECT * FROM gp_unmatched_invoices WHERE id = ?").get(parseInt(req.params.id, 10));
      if (!um) return res.status(404).send("Unmatched invoice not found");
      const candidates = um.po_name
        ? GpJobs.findCandidatesByCustomer(um.po_name, { windowDays: 90, minSimilarity: 0.0 })
        : GpJobs.list({ limit: 100 }).map(j => ({ row: j, sim: 0 }));
      const rows = candidates.slice(0, 30).map(c => "<tr>" +
        "<td><strong>" + (c.row.customer_name || "?") + "</strong><br><span class='muted'>" + (c.row.customer_address || "") + "</span></td>" +
        "<td>" + (c.row.jobber_invoice_number || c.row.invoice_number || "") + "</td>" +
        "<td class='muted'>" + (c.row.jobber_invoice_issued_at || "") + "</td>" +
        "<td>$" + Number(c.row.amount_paid || 0).toFixed(2) + "</td>" +
        "<td><span class='badge badge-" + (c.sim >= 0.9 ? "manager" : c.sim >= 0.7 ? "admin" : "amber") + "'>" + (c.sim * 100).toFixed(0) + "%</span></td>" +
        "<td><form method='POST' action='/gross-profit/unmatched/" + um.id + "/resolve' style='display:inline'>" +
        "<input type='hidden' name='jobId' value='" + c.row.id + "'>" +
        "<button type='submit' class='btn'>Attach to job #" + c.row.id + "</button>" +
        "</form></td></tr>"
      ).join("");
      const att = um.attachment_id ? GpAttachments.byId(um.attachment_id) : null;
      const pdfLink = att ? "<p><a href='/gross-profit/attachment/" + att.id + "' target='_blank'>View attached PDF: " + att.filename + "</a></p>" : "";
      const body = "<p>Unmatched invoice <strong>#" + um.id + "</strong> from <strong>" + um.supplier + "</strong>" +
                   (um.po_name ? " (PO: <em>" + um.po_name + "</em>)" : " (no PO extracted)") + "." +
                   (um.total_amount ? " Total: $" + Number(um.total_amount).toFixed(2) : "") + "</p>" +
                   pdfLink +
                   "<p>Pick the job to attach this invoice to. Top match shown first.</p>" +
                   "<table class='data-table'><thead><tr><th>Customer</th><th>Invoice #</th><th>Issued</th><th>Amount paid</th><th>Match</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>" +
                   "<p style='margin-top:14px'><a href='/gross-profit'>&larr; back to Gross Profit</a></p>";
      res.send(views.placeholderPage({ user: req.user, navKey: "gross-profit", title: "Resolve unmatched invoice", body }));
    } catch (e) {
      res.status(500).send("resolve UI failed: " + e.message);
    }
  });

  // ----- Manual attach: POST applies the chosen job -----
  router.post("/gross-profit/unmatched/:id(\\d+)/resolve", requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
    try {
      const { db } = await import("./db.js");
      const um = db.prepare("SELECT * FROM gp_unmatched_invoices WHERE id = ?").get(parseInt(req.params.id, 10));
      if (!um) throw new Error("Unmatched invoice not found");
      const jobId = parseInt(req.body.jobId, 10);
      if (!jobId) throw new Error("No job selected");
      const att = um.attachment_id ? GpAttachments.byId(um.attachment_id) : null;
      const meta = att && att.metadata_json ? JSON.parse(att.metadata_json) : {};
      const parsed = meta.parsed || {};
      GpJobs.applySupplierInvoice(jobId, {
        equipmentCost: parsed.equipment || 0,
        materialsCost: parsed.materials || 0,
        totalWithTax: parsed.total || null,
      }, { attachmentId: um.attachment_id });
      GpUnmatched.resolve(um.id, jobId);
      req.session.flash = { type: "ok", message: "Attached invoice #" + um.id + " to job #" + jobId };
    } catch (e) {
      req.session.flash = { type: "error", message: "Attach failed: " + e.message };
    }
    res.redirect("/gross-profit");
  });


  // ----- Admin: inspect raw email body for one unmatched row (parser tuning) -----
  router.get("/gross-profit/unmatched/:id(\\d+)/debug-body", requireAdmin, async (req, res) => {
    try {
      const { db } = await import("./db.js");
      const um = db.prepare(`SELECT u.*, a.gmail_message_id, a.metadata_json
                               FROM gp_unmatched_invoices u
                               JOIN gp_attachments a ON a.id = u.attachment_id
                              WHERE u.id = ?`).get(parseInt(req.params.id, 10));
      if (!um) return res.status(404).json({ error: "not found" });
      if (!um.gmail_message_id) return res.json({ error: "no gmail_message_id on attachment", um });
      const fs = await import("fs");
      const { google } = await import("googleapis");
      const gmailMod = await import("./gmail.js");
      let creds;
      if (process.env.GOOGLE_SA_JSON) creds = JSON.parse(process.env.GOOGLE_SA_JSON);
      else creds = JSON.parse(fs.readFileSync("/etc/secrets/google-sa.json", "utf8"));
      const usersList = (process.env.GMAIL_DELEGATED_USERS || "").split(",").map(s => s.trim()).filter(Boolean);
      let full = null, fromUser = null;
      for (const userEmail of usersList) {
        try {
          const auth = new google.auth.JWT({
            email: creds.client_email, key: creds.private_key,
            scopes: ["https://www.googleapis.com/auth/gmail.readonly"], subject: userEmail,
          });
          await auth.authorize();
          const gm = google.gmail({ version: "v1", auth });
          full = await gm.users.messages.get({ userId: "me", id: um.gmail_message_id, format: "full" });
          if (full?.data?.payload) { fromUser = userEmail; break; }
        } catch (e) { /* try next */ }
      }
      if (!full?.data?.payload) return res.json({ error: "couldn't fetch message in any mailbox" });
      const headers = Object.fromEntries(
        (full.data.payload.headers || []).map(h => [h.name.toLowerCase(), h.value])
      );
      const body = gmailMod.extractBodyText(full.data.payload);
      res.json({
        unmatched_id: um.id,
        supplier: um.supplier,
        old_po: um.po_name,
        gmail_message_id: um.gmail_message_id,
        mailbox: fromUser,
        from: headers["from"],
        subject: headers["subject"],
        date: headers["date"],
        bodyLength: body.length,
        bodyPreview: body.slice(0, 5000),
      });
    } catch (e) {
      res.status(500).json({ error: e.message, stack: e.stack });
    }
  });


  // ----- Gross Profit page -----
  router.get("/gross-profit", async (req, res) => {
    try {
      const { GpJobs, GpAttachments, GpUnmatched, GpInventory } = await import("./gross-profit.js");
      const jobberSync = await import("./jobber-sync.js");
      const sheets = await import("./sheets.js");
      const gmail = await import("./gmail.js");
      const jobs = GpJobs.list({ limit: 200 });
      const unmatched = GpUnmatched.list();
      const inventory = GpInventory.list();
      const status = {
        jobber: jobberSync.isConfigured ? jobberSync.isConfigured() : false,
        sheets: sheets.isConfigured ? sheets.isConfigured() : false,
        gmail: gmail.isConfigured(),
        ...(sheets.status ? sheets.status() : {}),
        ...(gmail.status ? gmail.status() : {}),
      };
      res.send(views.grossProfitPage({
        user: req.user,
        jobs, unmatched, inventory, status,
        flash: req.session.flash,
      }));
      delete req.session.flash;
    } catch (e) {
      console.error("[gross-profit] page failed", e);
      res.status(500).send("Gross Profit page failed: " + e.message);
    }
  });


  return router;
}
