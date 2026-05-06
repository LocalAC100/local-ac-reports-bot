// HTML template functions. Plain template-literal strings, no view engine.
// Brand colors derived from the Local AC logo:
//   primary blue  #1B57A8  (LOCAL AC text, nav background, primary buttons)
//   cyan          #28B5E1  (snowflake, links, accents)
//   alert red     #E63952  ("HEAT" emphasis, flags, live alerts)

const LOGO_SVG = `<svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg" aria-label="Local AC">
  <path d="M30 4 C18 4 10 13 10 24 c0 14 20 32 20 32 s20-18 20-32 c0-11-8-20-20-20 z" fill="#1B57A8"/>
  <circle cx="30" cy="22" r="11" fill="#fff"/>
  <g stroke="#28B5E1" stroke-width="2" stroke-linecap="round">
    <line x1="30" y1="14" x2="30" y2="30"/>
    <line x1="22" y1="22" x2="38" y2="22"/>
    <line x1="24" y1="16" x2="36" y2="28"/>
    <line x1="36" y1="16" x2="24" y2="28"/>
    <line x1="30" y1="14" x2="27" y2="17"/>
    <line x1="30" y1="14" x2="33" y2="17"/>
    <line x1="30" y1="30" x2="27" y2="27"/>
    <line x1="30" y1="30" x2="33" y2="27"/>
    <line x1="22" y1="22" x2="25" y2="19"/>
    <line x1="22" y1="22" x2="25" y2="25"/>
    <line x1="38" y1="22" x2="35" y2="19"/>
    <line x1="38" y1="22" x2="35" y2="25"/>
  </g>
</svg>`;

const FAVICON_DATA_URL = `data:image/svg+xml;utf8,${encodeURIComponent(LOGO_SVG)}`;

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------- Layout ----------
export function layout({ title, body, user, flash, activeNav = "" }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)} · Control Room</title>
  <link rel="icon" href="${FAVICON_DATA_URL}">
  <link rel="stylesheet" href="/styles.css">
</head>
<body>
  ${user ? renderNav({ user, activeNav }) : ""}
  <main class="${user ? "with-nav" : "no-nav"}">
    ${flash ? `<div class="flash flash-${flash.type}">${escape(flash.message)}</div>` : ""}
    ${body}
  </main>
</body>
</html>`;
}

function renderNav({ user, activeNav }) {
  const nav = [
    { href: "/", label: "Today", key: "today" },
    { href: "/employees", label: "Employees", key: "employees" },
    { href: "/dispatchers", label: "Dispatchers", key: "dispatchers" },
    { href: "/leads", label: "Leads", key: "leads" },
    { href: "/alerts", label: "Alerts", key: "alerts" },
    { href: "/reports", label: "Reports", key: "reports" },
    { href: "/gross-profit", label: "Gross Profit", key: "gross-profit" },
    { href: "/ask", label: "Ask Claude", key: "ask" },
  ];
  if (user.role === "admin") nav.push({ href: "/settings/users", label: "Users", key: "users" });
  return `<header class="topbar">
  <div class="brand">
    <div class="brand-icon">${LOGO_SVG}</div>
    <div class="brand-text">Control Room</div>
  </div>
  <nav class="primary-nav">
    ${nav.map(n => `<a href="${n.href}" class="${activeNav === n.key ? "active" : ""}">${n.label}</a>`).join("")}
  </nav>
  <div class="user-menu">
    <span class="user-name">${escape(user.name || user.email)}</span>
    <span class="user-role">${escape(user.role)}</span>
    <a href="/logout" class="logout-link">Sign out</a>
  </div>
</header>
<button class="mobile-nav-toggle" onclick="document.querySelector('.primary-nav').classList.toggle('open')" aria-label="Open menu">☰</button>`;
}

// ---------- Login ----------
export function loginPage({ error } = {}) {
  return layout({
    title: "Sign in",
    body: `
<div class="login-wrap">
  <div class="login-card">
    <div class="login-brand">
      <div class="login-icon">${LOGO_SVG}</div>
      <div class="login-title">Control Room</div>
      <div class="login-sub">Local AC operations dashboard</div>
    </div>
    ${error ? `<div class="login-error">${escape(error)}</div>` : ""}
    <form method="post" action="/login" class="login-form">
      <label>Email
        <input type="email" name="email" required autocomplete="username" autofocus>
      </label>
      <label>Password
        <input type="password" name="password" required autocomplete="current-password">
      </label>
      <button type="submit" class="btn btn-primary">Sign in</button>
    </form>
  </div>
</div>`,
  });
}

// ---------- Today (Home) ----------
export function todayPage({ user, snapshot }) {
  const { activeNow = [], alertsToday = 0, callsToday = 0, leadsToday = 0, recentAlerts = [], discrepancies = [] } = snapshot || {};
  return layout({
    title: "Today",
    user, activeNav: "today",
    body: `
<div class="page-head">
  <h1>Today's snapshot</h1>
  <span class="page-sub">${new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}</span>
</div>
<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-label">Active right now</div>
    <div class="kpi-value">${activeNow.length}</div>
    <div class="kpi-sub">${activeNow.map(escape).join(" · ") || "—"}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Calls today</div>
    <div class="kpi-value">${callsToday}</div>
    <div class="kpi-sub">across all dispatchers</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Leads today</div>
    <div class="kpi-value">${leadsToday}</div>
    <div class="kpi-sub">new contacts in GHL</div>
  </div>
  <div class="kpi-card ${alertsToday > 0 ? "kpi-alert" : ""}">
    <div class="kpi-label">Live alerts today</div>
    <div class="kpi-value">${alertsToday}</div>
    <div class="kpi-sub">leads not contacted in 3 min</div>
  </div>
</div>

<section class="panel">
  <h2>Schedule discrepancies</h2>
  ${discrepancies.length === 0
    ? `<div class="empty-good">✓ Everyone scheduled today is clocked in. No issues.</div>`
    : `<ul class="alert-list">${discrepancies.map(d => `<li><strong>${escape(d.employee)}</strong> — ${escape(d.detail)}</li>`).join("")}</ul>`}
</section>

<section class="panel">
  <h2>Recent live alerts</h2>
  ${recentAlerts.length === 0
    ? `<div class="empty-good">No live alerts in the last 7 days.</div>`
    : `<ul class="alert-list">${recentAlerts.map(a => `<li><span class="badge badge-red">🔴 ${a.minutes_elapsed}m</span> <strong>${escape(a.contact_name || "(unnamed)")}</strong> · ${escape(a.phone || "")} · ${escape(a.fired_at)}</li>`).join("")}</ul>`}
</section>`,
  });
}

// ---------- Generic placeholder for pages we'll fill in ----------
export function placeholderPage({ user, title, navKey, body = "" }) {
  return layout({
    title, user, activeNav: navKey,
    body: `
<div class="page-head"><h1>${escape(title)}</h1></div>
<section class="panel">
  ${body || `<p class="muted">This page is being built. Pull data and views coming next.</p>`}
</section>`,
  });
}

// ---------- Ask Claude ----------
export function askPage({ user, history = [], hasApiKey }) {
  const messagesHtml = history.map(m => `
    <div class="msg msg-${m.role}">
      <div class="msg-role">${m.role === "user" ? "You" : "Claude"}</div>
      <div class="msg-body">${escape(m.content).replace(/\n/g, "<br>")}</div>
    </div>`).join("");
  return layout({
    title: "Ask Claude", user, activeNav: "ask",
    body: `
<div class="page-head">
  <h1>Ask Claude</h1>
  <span class="page-sub">Ask anything about your business — Claude has access to Hubstaff, GoHighLevel, and Jobber.</span>
</div>
${!hasApiKey ? `<div class="banner-warn">⚠ Anthropic API key not configured yet. Add <code>ANTHROPIC_API_KEY</code> in Render's Environment tab to activate.</div>` : ""}
<div class="chat-wrap">
  <div class="chat-history" id="chatHistory">
    ${messagesHtml || `<div class="chat-empty">
      <p>Try asking:</p>
      <ul>
        <li>"How many jobs did we close yesterday?"</li>
        <li>"Show me unscheduled jobs from this week."</li>
        <li>"How are dispatchers doing today?"</li>
        <li>"What's our pipeline looking like for tomorrow?"</li>
      </ul>
    </div>`}
  </div>
  <form class="chat-form" id="chatForm">
    <textarea name="question" id="question" rows="2" placeholder="Ask Claude about Jobber, Hubstaff, or GHL..." ${!hasApiKey ? "disabled" : ""}></textarea>
    <button type="submit" class="btn btn-primary" ${!hasApiKey ? "disabled" : ""}>Send</button>
  </form>
</div>
<script>
const form = document.getElementById('chatForm');
const history = document.getElementById('chatHistory');
const ta = document.getElementById('question');
form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = ta.value.trim();
  if (!q) return;
  ta.value = '';
  history.insertAdjacentHTML('beforeend', '<div class="msg msg-user"><div class="msg-role">You</div><div class="msg-body">' + q.replace(/</g,'&lt;').replace(/\\n/g,'<br>') + '</div></div>');
  history.insertAdjacentHTML('beforeend', '<div class="msg msg-assistant pending"><div class="msg-role">Claude</div><div class="msg-body">…thinking…</div></div>');
  history.scrollTop = history.scrollHeight;
  const r = await fetch('/api/ask', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ question: q }) });
  const d = await r.json();
  const last = history.querySelector('.msg.pending');
  if (last) last.remove();
  history.insertAdjacentHTML('beforeend', '<div class="msg msg-assistant"><div class="msg-role">Claude</div><div class="msg-body">' + (d.answer || d.error || 'no response').replace(/</g,'&lt;').replace(/\\n/g,'<br>') + '</div></div>');
  history.scrollTop = history.scrollHeight;
});
</script>`,
  });
}

// ---------- Users (admin) ----------
export function usersPage({ user, users, flash }) {
  return layout({
    title: "Users", user, activeNav: "users", flash,
    body: `
<div class="page-head"><h1>Users</h1></div>
<section class="panel">
  <table class="data-table">
    <thead><tr><th>Email</th><th>Name</th><th>Role</th><th>Created</th><th>Last login</th></tr></thead>
    <tbody>${users.map(u => `<tr>
      <td>${escape(u.email)}</td>
      <td>${escape(u.name || "")}</td>
      <td><span class="badge badge-${u.role}">${escape(u.role)}</span></td>
      <td class="muted">${escape((u.created_at || "").slice(0, 10))}</td>
      <td class="muted">${escape((u.last_login_at || "—").slice(0, 16))}</td>
    </tr>`).join("")}</tbody>
  </table>
</section>
<section class="panel">
  <h2>Add user</h2>
  <form method="post" action="/settings/users" class="form-grid">
    <label>Email <input type="email" name="email" required></label>
    <label>Name <input type="text" name="name" required></label>
    <label>Password <input type="password" name="password" minlength="8" required></label>
    <label>Role
      <select name="role">
        <option value="manager">Manager (read-only)</option>
        <option value="admin">Admin</option>
      </select>
    </label>
    <button type="submit" class="btn btn-primary">Create user</button>
  </form
</section>`,
  });
}

// ---------- Gross Profit ----------
function money(v) {
  if (v == null || v === "") return "—";
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return String(v);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v) {
  if (v == null || v === "") return "—";
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(1) + "%";
}
function gpClass(p) {
  if (p == null) return "";
  const n = parseFloat(p);
  if (!Number.isFinite(n)) return "";
  if (n >= 35) return "gp-good";
  if (n >= 20) return "gp-ok";
  return "gp-bad";
}

export function grossProfitPage({ user, jobs, unmatched, inventory, status, flash }) {
  const empty = jobs.length === 0;
  const rows = jobs.map((j) => {
    const completeness = [
      j.amount_paid != null ? "Jobber" : null,
      j.salesperson_name || j.permit_required != null || j.sales_commission_amount != null ? "Sheet" : null,
      j.equipment_materials_total != null ? "Suppliers" : null,
    ].filter(Boolean);
    return `<tr>
      <td><a href="/gross-profit/${j.id}"><strong>${escape(j.customer_name || "(no name)")}</strong></a><br>
        <span class="muted">${escape(j.address || "")}${j.city ? ", " + escape(j.city) : ""}</span></td>
      <td>${escape(j.jobber_invoice_number || "—")}</td>
      <td>${money(j.amount_paid)}</td>
      <td>${money(j.equipment_materials_total)}</td>
      <td>${money(j.total_labor_cost)}</td>
      <td><strong>${money(j.gross_profit_dollars)}</strong></td>
      <td><span class="gp-pct ${gpClass(j.gross_profit_percent)}">${pct(j.gross_profit_percent)}</span></td>
      <td class="muted">${completeness.map(c => `<span class="badge badge-${c.toLowerCase()}">${escape(c)}</span>`).join(" ")}</td>
    </tr>`;
  }).join("");

  const tableHtml = empty
    ? `<div class="empty-good">No jobs yet — waiting for first Jobber invoice. Open the <a href="/gross-profit/setup">setup checklist</a> to wire up the integrations.</div>`
    : `<table class="data-table">
        <thead><tr>
          <th>Customer / Address</th><th>Invoice #</th><th>Amount paid</th>
          <th>Equip + Mat</th><th>Labor</th><th>GP $</th><th>GP %</th><th>Sources</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;

  const unmatchedHtml = unmatched.length === 0 ? "" : `
    <section class="panel panel-warn">
      <h2>⚠ Unmatched Invoices — Review Manually</h2>
      <table class="data-table">
        <thead><tr><th>Supplier</th><th>PO / customer name</th><th>Total</th><th>Attachment</th><th>Received</th><th></th></tr></thead>
        <tbody>${unmatched.map(u => `<tr>
          <td>${escape(u.supplier)}</td>
          <td>${escape(u.po_name || "—")}</td>
          <td>${money(u.total_amount)}</td>
          <td>${u.att_id ? `<a href="/gross-profit/attachment/${u.att_id}">${escape(u.filename || "PDF")}</a>` : "—"}</td>
          <td class="muted">${escape((u.created_at || "").slice(0,16))}</td>
          <td><a href="/gross-profit/unmatched/${u.id}/resolve">Resolve →</a></td>
        </tr>`).join("")}</tbody>
      </table>
    </section>`;

  const inventoryHtml = inventory.length === 0 ? "" : `
    <section class="panel">
      <h2>Inventory invoices (not tied to a job)</h2>
      <table class="data-table">
        <thead><tr><th>Supplier</th><th>Total</th><th>Attachment</th><th>Notes</th><th>Received</th></tr></thead>
        <tbody>${inventory.map(i => `<tr>
          <td>${escape(i.supplier)}</td>
          <td>${money(i.total_amount)}</td>
          <td>${escape(i.filename || "—")}</td>
          <td class="muted">${escape(i.notes || "")}</td>
          <td class="muted">${escape((i.created_at || "").slice(0,16))}</td>
        </tr>`).join("")}</tbody>
      </table>
    </section>`;

  // Status panel — shows whether each connector is wired up
  const statusItem = (label, ok, hint) =>
    `<li><span class="status-dot ${ok ? "ok" : "off"}"></span> <strong>${escape(label)}</strong> — ${ok ? "ready" : escape(hint || "not configured")}</li>`;

  const yr = new Date().getFullYear();
  const setupHtml = `
    <section class="panel">
      <h2>Integration status</h2>
      <ul class="status-list">
        ${statusItem("Jobber sync (invoices → rows)", status.jobber, "Set JOBBER_CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN")}
        ${statusItem("Google Sheets (Chris's sheet → rows)", status.sheets && status.chrisSheetId, "Set GOOGLE_SA_JSON + CHRIS_SHEET_ID")}
        ${statusItem("Mirror sheet (rows → Google Sheet)", status.sheets && status.mirrorSheetId, "Set GOOGLE_SA_JSON + MIRROR_SHEET_ID")}
        ${statusItem("Gmail watcher (supplier invoices → rows)", status.gmail, "Set GOOGLE_SA_JSON + GMAIL_DELEGATED_USER (with domain-wide delegation)")}
      </ul>
      ${user.role === "admin" ? `
      <div class="action-row" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">
        <form method="post" action="/gross-profit/sync/jobber"><button class="btn">Sync Jobber now</button></form>
        <form method="post" action="/gross-profit/sync/sheets"><button class="btn">Scan Chris's sheet</button></form>
        <form method="post" action="/gross-profit/sync/gmail"><button class="btn">Run Gmail watcher</button></form>
        <form method="post" action="/gross-profit/sync/mirror"><button class="btn">Sync mirror sheet</button></form>
        <form method="post" action="/gross-profit/sync/backfill" onsubmit="return confirm('Backfill every Jobber invoice issued since ${yr}-01-01? Safe to re-run; idempotent.')">
          <input type="hidden" name="since" value="${yr}-01-01">
          <button class="btn btn-primary">Backfill ${yr} invoices</button>
        </form>
      </div>` : ""}
    </section>`;

  return layout({
    title: "Gross Profit", user, activeNav: "gross-profit", flash,
    body: `
<div class="page-head">
  <h1>Gross Profit Tracker</h1>
  <span class="page-sub">${jobs.length} job${jobs.length === 1 ? "" : "s"} on file</span>
</div>
${setupHtml}
<section class="panel">
  <h2>Jobs</h2>
  ${tableHtml}
</section>
${unmatchedHtml}
${inventoryHtml}
`,
  });
}

export function grossProfitJobPage({ user, job }) {
  if (!job) {
    return placeholderPage({ user, title: "Job not found", navKey: "gross-profit", body: "<p>That job doesn't exist.</p>" });
  }
  const li = (kind) => job.line_items.filter(x => x.kind === kind);
  const itemsHtml = (rows) => rows.length === 0 ? `<p class="muted">—</p>` : `<table class="data-table"><tbody>${rows.map(r => `<tr><td>${escape(r.description || r.labor_name || "")}</td><td>${escape(r.labor_type || "")}</td><td class="num">${money(r.amount)}</td><td class="muted">${escape(r.source || "")}</td></tr>`).join("")}</tbody></table>`;

  const att = job.attachments.map(a => `<li><a href="/gross-profit/attachment/${a.id}">${escape(a.filename)}</a> <span class="muted">${escape(a.source)}${a.supplier ? " · " + escape(a.supplier) : ""}</span></li>`).join("");

  return layout({
    title: `Job ${job.jobber_invoice_number || job.id}`, user, activeNav: "gross-profit",
    body: `
<div class="page-head">
  <h1>${escape(job.customer_name || "(no name)")}</h1>
  <span class="page-sub">Invoice ${escape(job.jobber_invoice_number || "—")} · ${escape(job.address || "")}${job.city ? ", " + escape(job.city) : ""} ${escape(job.zip || "")}</span>
</div>
<div class="kpi-grid">
  <div class="kpi-card"><div class="kpi-label">Amount paid</div><div class="kpi-value">${money(job.amount_paid)}</div><div class="kpi-sub">${escape(job.payment_method || "—")}</div></div>
  <div class="kpi-card"><div class="kpi-label">Equip + Materials</div><div class="kpi-value">${money(job.equipment_materials_total)}</div><div class="kpi-sub">Equip ${money(job.equipment_cost)} · Mat ${money(job.materials_cost)}</div></div>
  <div class="kpi-card"><div class="kpi-label">Labor + Other</div><div class="kpi-value">${money((job.total_labor_cost || 0) + (job.total_other_expenses || 0))}</div><div class="kpi-sub">Labor ${money(job.total_labor_cost)} · Other ${money(job.total_other_expenses)}</div></div>
  <div class="kpi-card ${gpClass(job.gross_profit_percent)}"><div class="kpi-label">Gross profit</div><div class="kpi-value">${money(job.gross_profit_dollars)}</div><div class="kpi-sub">${pct(job.gross_profit_percent)}</div></div>
</div>

<section class="panel">
  <h2>Invoice line items (Jobber)</h2>
  ${itemsHtml(li("invoice_item"))}
</section>
<section class="panel">
  <h2>Products sold (Sheet)</h2>
  ${itemsHtml(li("product_sold"))}
</section>
<section class="panel">
  <h2>Labor (Sheet)</h2>
  ${itemsHtml(li("labor"))}
</section>
<section class="panel">
  <h2>Other expenses (Sheet)</h2>
  ${itemsHtml(li("other_expense"))}
</section>
<section class="panel">
  <h2>Sales / commissions / permit</h2>
  <table class="data-table"><tbody>
    <tr><td>Salesperson</td><td>${escape(job.salesperson_name || "—")}</td></tr>
    <tr><td>Sales commission</td><td>${money(job.sales_commission_amount)} (${pct(job.sales_commission_rate)})</td></tr>
    <tr><td>Sales manager</td><td>${escape(job.sales_manager_name || "—")} — ${money(job.sales_manager_fee)}</td></tr>
    <tr><td>Permit</td><td>${job.permit_required == null ? "—" : (job.permit_required ? "Yes" : "No")} — ${money(job.permit_fee)}</td></tr>
    <tr><td>Fee</td><td>${money(job.fee_amount)} (${escape(job.fee_type || "—")})</td></tr>
  </tbody></table>
</section>
<section class="panel">
  <h2>Attached docs</h2>
  ${att ? `<ul class="alert-list">${att}</ul>` : `<p class="muted">No attachments yet.</p>`}
</section>
<p><a href="/gross-profit">← back to all jobs</a></p>
`,
  });
}
