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
