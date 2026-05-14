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
  return String(s || "").replace(/&/g, "&amp;")
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
  <title>${escape(title)} |* Control Room</title>
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
    { href: "/dispatch", label: "Dispatch", key: "dispatch" },
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
<button class="mobile-nav-toggle" onclick="document.querySelector('.primary-nav').classList.toggle('open')" aria-label="Open menu">|deg</button>`;
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
    <div class="kpi-sub">${activeNow.map(escape).join(" |* ") || "|"}</div>
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
    ? `<div class="empty-good">| Everyone scheduled today is clocked in. No issues.</div>`
    : `<ul class="alert-list">${discrepancies.map(d => `<li><strong>${escape(d.employee)}</strong> | ${escape(d.detail)}</li>`).join("")}</ul>`}
</section>

<section class="panel">
  <h2>Recent live alerts</h2>
  ${recentAlerts.length === 0
    ? `<div class="empty-good">No live alerts in the last 7 days.</div>`
    : `<ul class="alert-list">${recentAlerts.map(a => `<li><span class="badge badge-red">?deg| ${a.minutes_elapsed}m</span> <strong>${escape(a.contact_name || "(unnamed)")}</strong> |* ${escape(a.phone || "")} |* ${escape(a.fired_at)}</li>`).join("")}</ul>`}
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
  <span class="page-sub">Ask anything about your business | Claude has access to Hubstaff, GoHighLevel, and Jobber.</span>
</div>
${!hasApiKey ? `<div class="banner-warn">|  Anthropic API key not configured yet. Add <code>ANTHROPIC_API_KEY</code> in Render's Environment tab to activate.</div>` : ""}
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
  history.insertAdjacentHTML('beforeend', '<div class="msg msg-assistant pending"><div class="msg-role">Claude</div><div class="msg-body">|thinking|</div></div>');
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
      <td class="muted">${escape((u.last_login_at || "|").slice(0, 16))}</td>
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
  if (v == null || v === "") return "|";
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return String(v);
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function pct(v) {
  if (v == null || v === "") return "|";
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return "|";
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

export function grossProfitPage({ user, jobs, unmatched, inventory, status, flash, filter = {}, totalCount = 0, totalPaid = 0, totalInvoiced = 0, totalDue = 0, grandTotalCount = 0, summary = null }) {
  const empty = jobs.length === 0;
  // Per-row qualification flags. "Info complete" = data from all 3 sources.
  // "Paid" = any payment received (amount_paid > 0). Both must be ticked
  // for the row to count toward the GP totals at the top.
  const isInfoComplete = (job) =>
    job.amount_paid != null &&
    job.equipment_materials_total != null &&
    job.total_labor_cost != null;
  const isPaid = (job) => Number(job.amount_paid || 0) > 0;
  const yesBadge = `<span class="badge badge-ok" title="Yes" style="display:inline-block;min-width:32px;text-align:center;background:#1f9a4a;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600">YES</span>`;
  const noBadge = `<span class="badge badge-warn" title="No" style="display:inline-block;min-width:32px;text-align:center;background:#d04545;color:#fff;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600">NO</span>`;
  const fmtMoney = (n) =>
    "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  const fmtPct = (n) =>
    n == null ? "-" : Number(n).toFixed(1) + "%";
  // Summary tiles. If summary is null (older callers), fall back to zeros.
  const s = summary || { qualified: 0, qualified_sales: 0, qualified_gp_dollars: 0, qualified_gp_percent: null, paid: 0, info_complete: 0, total: totalCount };
  const summaryHtml = `
<section class="panel" style="background:#fafbfd">
  <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
    <h2 style="margin:0">Gross profit summary</h2>
    <div class="muted" style="font-size:12px">Counts only invoices that are <strong>paid</strong> AND have <strong>complete info</strong> (Jobber + suppliers + labor)</div>
  </div>
  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-top:12px">
    <div style="padding:12px 14px;background:#fff;border:1px solid #e5e9f0;border-radius:8px">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Qualified invoices</div>
      <div style="font-size:24px;font-weight:600;color:#1B57A8">${s.qualified.toLocaleString()}</div>
      <div class="muted" style="font-size:11px;margin-top:2px">of ${s.total.toLocaleString()} in range</div>
    </div>
    <div style="padding:12px 14px;background:#fff;border:1px solid #e5e9f0;border-radius:8px">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Total sales</div>
      <div style="font-size:24px;font-weight:600;color:#1B57A8">${fmtMoney(s.qualified_sales)}</div>
      <div class="muted" style="font-size:11px;margin-top:2px">amount paid (qualified rows)</div>
    </div>
    <div style="padding:12px 14px;background:#fff;border:1px solid #e5e9f0;border-radius:8px">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Gross profit $</div>
      <div style="font-size:24px;font-weight:600;color:${s.qualified_gp_dollars >= 0 ? '#147a3e' : '#b3261e'}">${fmtMoney(s.qualified_gp_dollars)}</div>
      <div class="muted" style="font-size:11px;margin-top:2px">sales - costs (qualified rows)</div>
    </div>
    <div style="padding:12px 14px;background:#fff;border:1px solid #e5e9f0;border-radius:8px">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Gross profit %</div>
      <div style="font-size:24px;font-weight:600;color:${(s.qualified_gp_percent || 0) >= 0 ? '#147a3e' : '#b3261e'}">${fmtPct(s.qualified_gp_percent)}</div>
      <div class="muted" style="font-size:11px;margin-top:2px">GP $ / sales</div>
    </div>
    <div style="padding:12px 14px;background:#fff;border:1px solid #e5e9f0;border-radius:8px">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Total paid</div>
      <div style="font-size:24px;font-weight:600;color:#147a3e">${fmtMoney(totalPaid)}</div>
      <div class="muted" style="font-size:11px;margin-top:2px">received in range</div>
    </div>
    <div style="padding:12px 14px;background:#fff;border:1px solid #e5e9f0;border-radius:8px">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px">Total due</div>
      <div style="font-size:24px;font-weight:600;color:${totalDue > 0 ? '#b3261e' : '#666'}">${fmtMoney(totalDue)}</div>
      <div class="muted" style="font-size:11px;margin-top:2px">invoiced ${fmtMoney(totalInvoiced)} - paid</div></div>
  </div>
  <div class="muted" style="font-size:12px;margin-top:10px">
    Coverage in this range: <strong>${s.paid.toLocaleString()}</strong> paid * <strong>${s.info_complete.toLocaleString()}</strong> info complete * <strong>${s.qualified.toLocaleString()}</strong> qualified
  </div>
</section>`;
  const preset = filter.preset || "all";
  const fromVal = filter.from || "";
  const toVal = filter.to || "";
  // Quick-filter button list. Active button gets aria-current="true" so CSS lights it up.
  const months = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
  const monthLabel = (m) => ({jan:"Jan",feb:"Feb",mar:"Mar",apr:"Apr",may:"May",jun:"Jun",jul:"Jul",aug:"Aug",sep:"Sep",oct:"Oct",nov:"Nov",dec:"Dec"}[m]);
  const presetBtn = (key, label) => {
    const isActive = preset === key;
    return `<a href="/gross-profit?preset=${encodeURIComponent(key)}" class="filter-btn${isActive ? " is-active" : ""}"${isActive ? " aria-current=\"true\"" : ""}>${label}</a>`;
  };
  const monthBtns = months.map(m => presetBtn(`${m}-2026`, `${monthLabel(m)} 2026`)).join("");
  const filterHtml = `
<section class="panel" style="background:#f9fafc">
  <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px">
    <h2 style="margin:0">Filter by date issued</h2>
    <div class="muted" style="font-size:13px">
      Showing <strong>${totalCount.toLocaleString()}</strong> invoice${totalCount === 1 ? "" : "s"}
      ${preset === "all" ? "" : ` of ${grandTotalCount.toLocaleString()} total`}
      | Total paid: <strong>${Number(totalPaid || 0).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })}</strong>
    </div>
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
    ${presetBtn("all", "All time")}
    ${presetBtn("year", `Calendar year (${new Date().getFullYear()})`)}
    ${presetBtn("last-30", "Last 30 days")}
    ${presetBtn("last-90", "Last 90 days")}
  </div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
    ${monthBtns}
  </div>
  <form method="get" action="/gross-profit" style="display:flex;gap:8px;align-items:end;margin-top:14px;flex-wrap:wrap">
    <label style="font-size:12px;color:#666">From <input type="date" name="from" value="${fromVal}" style="margin-left:4px"></label>
    <label style="font-size:12px;color:#666">To <input type="date" name="to" value="${toVal}" style="margin-left:4px"></label>
    <button type="submit" class="filter-btn">Apply custom range</button>
  </form>
  <style>
    .filter-btn { display:inline-block; padding:6px 10px; border:1px solid #d0d7e2; border-radius:6px; background:#fff; color:#1B57A8; font-size:12px; text-decoration:none; cursor:pointer; }
    .filter-btn:hover { background:#eef3fa }
    .filter-btn.is-active { background:#1B57A8; color:#fff; border-color:#1B57A8 }
  </style>
</section>`;
  const rows = jobs.map((j) => {
    const completeness = [
      j.amount_paid != null ? "Jobber" : null,
      j.salesperson_name || j.permit_required != null || j.sales_commission_amount != null ? "Sheet" : null,
      j.equipment_materials_total != null ? "Suppliers" : null,
    ].filter(Boolean);
    const dashIfNull = (v) => (v == null || v === "") ? '<span class="muted">-</span>' : v;
    const moneyOrDash = (v) => v == null ? '<span class="muted">-</span>' : money(v);
    const pctOrDash = (v) => v == null ? '<span class="muted">-</span>' : (Number(v).toFixed(1) + "%");
    const yesNoBadge = (v) => v == null ? '<span class="muted">-</span>' : (v ? yesBadge : noBadge);
    const issuedDate = j.jobber_invoice_issued_at ? String(j.jobber_invoice_issued_at).slice(0, 10) : null;
    return `<tr>
      <td style="position:sticky;left:0;background:#fff;z-index:1;min-width:240px"><a href="/gross-profit/${j.id}"><strong>${escape(j.customer_name || "(no name)")}</strong></a><br>
        <span class="muted">${escape(j.address || "")}${j.city ? ", " + escape(j.city) : ""}</span></td>
      <td>${escape(j.jobber_invoice_number || "-")}</td>
      <td class="muted" style="white-space:nowrap">${dashIfNull(issuedDate)}</td>
      <td>${moneyOrDash(j.amount_paid)}</td>
      <td>${dashIfNull(escape(j.payment_method || ""))}</td>
      <td>${moneyOrDash(j.fee_amount)}</td>
      <td>${dashIfNull(escape(j.fee_type || ""))}</td>
      <td>${dashIfNull(escape(j.salesperson_name || ""))}</td>
      <td>${moneyOrDash(j.sales_commission_amount)}</td>
      <td>${j.sales_commission_rate == null ? '<span class="muted">-</span>' : (Number(j.sales_commission_rate).toFixed(1) + "%")}</td>
      <td>${dashIfNull(escape(j.sales_manager_name || ""))}</td>
      <td>${moneyOrDash(j.sales_manager_fee)}</td>
      <td>${yesNoBadge(j.permit_required)}</td>
      <td>${moneyOrDash(j.permit_fee)}</td>
      <td>${moneyOrDash(j.equipment_cost)}</td>
      <td>${moneyOrDash(j.materials_cost)}</td>
      <td>${moneyOrDash(j.equipment_materials_total)}</td>
      <td>${moneyOrDash(j.total_labor_cost)}</td>
      <td>${moneyOrDash(j.total_other_expenses)}</td>
      <td><strong>${moneyOrDash(j.gross_profit_dollars)}</strong></td>
      <td><span class="gp-pct ${gpClass(j.gross_profit_percent)}">${j.gross_profit_percent == null ? '-' : pct(j.gross_profit_percent)}</span></td>
      <td>${isInfoComplete(j) ? yesBadge : noBadge}</td>
      <td>${isPaid(j) ? yesBadge : noBadge}</td>
      <td class="muted">${completeness.map(c => `<span class="badge badge-${c.toLowerCase()}">${escape(c)}</span>`).join(" ")}</td>
    </tr>`;
  }).join("");

  const tableHtml = empty
    ? `<div class="empty-good">No jobs yet. Backfill 2026 invoices or wait for the next Jobber poll.</div>`
    : `<div style="overflow-x:auto;border:1px solid #e5e9f0;border-radius:8px">
      <table class="data-table" style="min-width:2200px">
        <thead><tr>
          <th style="position:sticky;left:0;background:#fafbfd;z-index:2;min-width:240px">Customer / Address</th>
          <th>Invoice #</th>
          <th>Issued</th>
          <th>Amount paid</th>
          <th>Pay method</th>
          <th>Fee $</th>
          <th>Fee type</th>
          <th>Salesperson</th>
          <th>Sales commission $</th>
          <th>Sales commission %</th>
          <th>Sales manager</th>
          <th>Sales mgr fee</th>
          <th>Permit?</th>
          <th>Permit fee</th>
          <th>Equipment $</th>
          <th>Materials $</th>
          <th>Equip + Mat</th>
          <th>Labor $</th>
          <th>Other expenses</th>
          <th>GP $</th>
          <th>GP %</th>
          <th>Info</th>
          <th>Paid</th>
          <th>Sources</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  const unmatchedHtml = unmatched.length === 0 ? "" : `
    <section class="panel panel-warn">
      <h2>|  Unmatched Invoices | Review Manually</h2>
      <table class="data-table">
        <thead><tr><th>Supplier</th><th>PO / customer name</th><th>Total</th><th>Attachment</th><th>Received</th><th></th></tr></thead>
        <tbody>${unmatched.map(u => `<tr>
          <td>${escape(u.supplier)}</td>
          <td>${escape(u.po_name || "|")}</td>
          <td>${money(u.total_amount)}</td>
          <td>${u.att_id ? `<a href="/gross-profit/attachment/${u.att_id}">${escape(u.filename || "PDF")}</a>` : "|"}</td>
          <td class="muted">${escape((u.created_at || "").slice(0,16))}</td>
          <td><a href="/gross-profit/unmatched/${u.id}/resolve">Resolve |</a></td>
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
          <td>${escape(i.filename || "|")}</td>
          <td class="muted">${escape(i.notes || "")}</td>
          <td class="muted">${escape((i.created_at || "").slice(0,16))}</td>
        </tr>`).join("")}</tbody>
      </table>
    </section>`;

  // Status panel | shows whether each connector is wired up
  const statusItem = (label, ok, hint) =>
    `<li><span class="status-dot ${ok ? "ok" : "off"}"></span> <strong>${escape(label)}</strong> | ${ok ? "ready" : escape(hint || "not configured")}</li>`;

  const yr = new Date().getFullYear();
  const setupHtml = `
    <section class="panel">
      <h2>Integration status</h2>
      <ul class="status-list">
        ${statusItem("Jobber sync (invoices | rows)", status.jobber, "Set JOBBER_CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN")}
        ${statusItem("Google Sheets (Chris's sheet | rows)", status.sheets && status.chrisSheetId, "Set GOOGLE_SA_JSON + CHRIS_SHEET_ID")}
        ${statusItem("Mirror sheet (rows | Google Sheet)", status.sheets && status.mirrorSheetId, "Set GOOGLE_SA_JSON + MIRROR_SHEET_ID")}
        ${statusItem("Gmail watcher (supplier invoices | rows)", status.gmail, "Set GOOGLE_SA_JSON + GMAIL_DELEGATED_USER (with domain-wide delegation)")}
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
  <span class="page-sub"><strong>${totalCount.toLocaleString()}</strong> invoice${totalCount === 1 ? "" : "s"}${preset === "all" ? "" : ` (filtered from ${grandTotalCount.toLocaleString()})`}</span>
</div>
${filterHtml}
${summaryHtml}
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
  const itemsHtml = (rows) => rows.length === 0 ? `<p class="muted">|</p>` : `<table class="data-table"><tbody>${rows.map(r => `<tr><td>${escape(r.description || r.labor_name || "")}</td><td>${escape(r.labor_type || "")}</td><td class="num">${money(r.amount)}</td><td class="muted">${escape(r.source || "")}</td></tr>`).join("")}</tbody></table>`;

  const att = job.attachments.map(a => `<li><a href="/gross-profit/attachment/${a.id}">${escape(a.filename)}</a> <span class="muted">${escape(a.source)}${a.supplier ? " |* " + escape(a.supplier) : ""}</span></li>`).join("");

  return layout({
    title: `Job ${job.jobber_invoice_number || job.id}`, user, activeNav: "gross-profit",
    body: `
<div class="page-head">
  <h1>${escape(job.customer_name || "(no name)")}</h1>
  <span class="page-sub">Invoice ${escape(job.jobber_invoice_number || "|")} |* ${escape(job.address || "")}${job.city ? ", " + escape(job.city) : ""} ${escape(job.zip || "")}</span>
</div>
<div class="kpi-grid">
  <div class="kpi-card"><div class="kpi-label">Amount paid</div><div class="kpi-value">${money(job.amount_paid)}</div><div class="kpi-sub">${escape(job.payment_method || "|")}</div></div>
  <div class="kpi-card"><div class="kpi-label">Equip + Materials</div><div class="kpi-value">${money(job.equipment_materials_total)}</div><div class="kpi-sub">Equip ${money(job.equipment_cost)} |* Mat ${money(job.materials_cost)}</div></div>
  <div class="kpi-card"><div class="kpi-label">Labor + Other</div><div class="kpi-value">${money((job.total_labor_cost || 0) + (job.total_other_expenses || 0))}</div><div class="kpi-sub">Labor ${money(job.total_labor_cost)} |* Other ${money(job.total_other_expenses)}</div></div>
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
    <tr><td>Salesperson</td><td>${escape(job.salesperson_name || "|")}</td></tr>
    <tr><td>Sales commission</td><td>${money(job.sales_commission_amount)} (${pct(job.sales_commission_rate)})</td></tr>
    <tr><td>Sales manager</td><td>${escape(job.sales_manager_name || "|")} | ${money(job.sales_manager_fee)}</td></tr>
    <tr><td>Permit</td><td>${job.permit_required == null ? "|" : (job.permit_required ? "Yes" : "No")} | ${money(job.permit_fee)}</td></tr>
    <tr><td>Fee</td><td>${money(job.fee_amount)} (${escape(job.fee_type || "|")})</td></tr>
  </tbody></table>
</section>
<section class="panel">
  <h2>Attached docs</h2>
  ${att ? `<ul class="alert-list">${att}</ul>` : `<p class="muted">No attachments yet.</p>`}
</section>
<p><a href="/gross-profit">| back to all jobs</a></p>
`,
  });
}
