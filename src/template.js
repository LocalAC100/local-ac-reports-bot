// HTML email template — Local AC Control Room reports.
// Mobile-first, inline styles only (most clients strip <style> tags).
// Brand palette: deep blue, cyan, snow white, with red used sparingly for alerts.
import { fmtDate, fmtDuration } from "./time.js";

const C = {
  primary: "#1B57A8",     // brand blue
  primaryDk: "#0F3F80",
  cyan: "#28B5E1",
  cyanBg: "#E8F6FC",
  red: "#C0392B",
  redBg: "#FDECEA",
  green: "#1E7E34",
  greenBg: "#E6F4EA",
  amber: "#A86D00",
  amberBg: "#FFF4D6",
  text: "#1F2937",
  textDim: "#6B7280",
  border: "#E5E7EB",
  bg: "#F4F6F9",
  white: "#FFFFFF",
  zebra: "#F9FAFB",
};

const FONT =
  "-apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Inline SVG of the Local AC pin + snowflake mark (so it works in every email
// client that supports SVG — Gmail, Apple Mail, iOS, Outlook on web).
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="44" viewBox="0 0 36 44" fill="none" aria-hidden="true">
  <path d="M18 0C8.06 0 0 8.06 0 18c0 12.6 18 26 18 26s18-13.4 18-26C36 8.06 27.94 0 18 0z" fill="#1B57A8"/>
  <circle cx="18" cy="18" r="11" fill="#28B5E1"/>
  <g stroke="#fff" stroke-width="1.6" stroke-linecap="round">
    <line x1="18" y1="11" x2="18" y2="25"/>
    <line x1="11" y1="18" x2="25" y2="18"/>
    <line x1="13" y1="13" x2="23" y2="23"/>
    <line x1="13" y1="23" x2="23" y2="13"/>
    <polyline points="16,12.5 18,11 20,12.5"/>
    <polyline points="16,23.5 18,25 20,23.5"/>
    <polyline points="12.5,16 11,18 12.5,20"/>
    <polyline points="23.5,16 25,18 23.5,20"/>
  </g>
</svg>`;

function pill(text, color = "red") {
  const fg = C[color] ?? C.red;
  const bg = C[`${color}Bg`] ?? C.redBg;
  return `<span style="background:${bg};color:${fg};padding:3px 8px;border-radius:999px;font-weight:600;font-size:12px;letter-spacing:.2px;display:inline-block">${text}</span>`;
}

function row(label, value) {
  return `<tr>
    <td style="padding:5px 10px 5px 0;color:${C.textDim};vertical-align:top;font-size:13px">${label}</td>
    <td style="padding:5px 0;color:${C.text};vertical-align:top;font-size:14px">${value}</td>
  </tr>`;
}

function sectionCard(title, body) {
  return `
  <div style="background:${C.white};border:1px solid ${C.border};border-radius:12px;padding:18px 22px;margin-bottom:16px;box-shadow:0 1px 2px rgba(15,63,128,.04)">
    <h2 style="margin:0 0 14px;font-size:16px;font-weight:700;color:${C.primaryDk};letter-spacing:.1px">${title}</h2>
    ${body}
  </div>`;
}

function tableOpen() {
  return `<table style="width:100%;border-collapse:collapse;font-size:13.5px;font-family:${FONT}">`;
}

function thRow(cols) {
  return `<tr style="background:${C.cyanBg};color:${C.primaryDk}">
    ${cols
      .map(
        (c) =>
          `<th style="text-align:${c.align || "left"};padding:9px 10px;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.4px;border-bottom:2px solid ${C.cyan}">${c.label}</th>`
      )
      .join("")}
  </tr>`;
}

function td(value, align = "left", extra = "") {
  return `<td style="padding:8px 10px;text-align:${align};color:${C.text};border-bottom:1px solid ${C.border};${extra}">${value}</td>`;
}

// ---------- Section 1: Hubstaff ----------

export function renderHubstaffSection(hub) {
  if (!hub) return sectionCard("Section 1 — Hubstaff (Hours & Activity)", "<em>No data available.</em>");
  const parts = [];

  // Headline status pill
  const flagCount =
    (hub.discrepancies?.length || 0) +
    (hub.lowActivityFlags?.length || 0) +
    (hub.manipulationFlags?.length || 0);
  if (flagCount === 0) {
    parts.push(`<div style="margin-bottom:12px">${pill("✓ No issues — everyone on schedule and active", "green")}</div>`);
  } else {
    parts.push(`<div style="margin-bottom:12px">${pill(`⚠ ${flagCount} item${flagCount === 1 ? "" : "s"} need${flagCount === 1 ? "s" : ""} attention`, "amber")}</div>`);
  }

  // Per-employee table — the heart of section 1
  if (hub.perEmployee?.length) {
    parts.push(tableOpen());
    parts.push(
      thRow([
        { label: "Employee", align: "left" },
        { label: "Clock in", align: "left" },
        { label: "Clock out", align: "left" },
        { label: "Worked", align: "right" },
        { label: "Break", align: "right" },
        { label: "Activity", align: "right" },
        { label: "Status", align: "left" },
      ])
    );
    for (let i = 0; i < hub.perEmployee.length; i++) {
      const e = hub.perEmployee[i];
      const zebra = i % 2 === 1 ? `background:${C.zebra};` : "";
      const status = e.statusFlag
        ? pill(e.statusFlag.text, e.statusFlag.color || "amber")
        : pill("✓ on track", "green");
      parts.push(`<tr style="${zebra}">
        ${td(`<strong>${e.name}</strong> <span style="color:${C.textDim};font-weight:400;font-size:12px">${e.role || ""}</span>`)}
        ${td(e.clockIn || "—", "left", `color:${e.clockIn ? C.text : C.textDim}`)}
        ${td(e.clockOut || "—", "left", `color:${e.clockOut ? C.text : C.textDim}`)}
        ${td(e.workedMinutes != null ? `<strong>${fmtDuration(e.workedMinutes)}</strong>` : "—", "right")}
        ${td(e.breakMinutes != null ? fmtDuration(e.breakMinutes) : "—", "right", e.breakOver ? `color:${C.red};font-weight:600` : "")}
        ${td(e.activityPct != null ? `${e.activityPct}%` : "—", "right", e.activityFlag ? `color:${C.red};font-weight:600` : "")}
        ${td(status)}
      </tr>`);
    }
    parts.push("</table>");
  }

  // Red flags spelled out (every flag becomes a live alert too — see "Live alerts" tab)
  const flags = [];
  for (const d of hub.discrepancies || []) {
    flags.push({
      level: "amber",
      text: `<strong>${d.employee}</strong> — ${d.detail}`,
      icon: "⚠",
    });
  }
  for (const f of hub.lowActivityFlags || []) {
    flags.push({
      level: f.alsoLowCalls ? "red" : "amber",
      text: `<strong>${f.employee}</strong> — low activity at ${f.hour} (${f.detail})${f.alsoLowCalls ? " · ALSO low calls" : ""}`,
      icon: f.alsoLowCalls ? "🔴" : "⚠",
    });
  }
  for (const f of hub.manipulationFlags || []) {
    flags.push({
      level: "red",
      text: `<strong>${f.employee}</strong> — possible screenshot manipulation ${f.windowLabel}: ${f.reason}`,
      icon: "🔴",
    });
  }
  if (flags.length) {
    parts.push(`<h3 style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${C.primaryDk};text-transform:uppercase;letter-spacing:.4px">Red flags</h3>`);
    parts.push("<ul style='margin:0;padding-left:18px;font-size:14px;line-height:1.6'>");
    for (const f of flags) {
      parts.push(`<li style="margin-bottom:6px;color:${f.level === "red" ? C.red : C.amber}">${f.icon}&nbsp; ${f.text}</li>`);
    }
    parts.push("</ul>");
    parts.push(`<div style="font-size:12px;color:${C.textDim};margin-top:8px">Each red flag also triggers a live alert in the Control Room (alerts tab).</div>`);
  }

  // Totals (evening report only — payroll cost summary)
  if (hub.totalsByEmployee?.length) {
    parts.push(`<h3 style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${C.primaryDk};text-transform:uppercase;letter-spacing:.4px">Day total</h3>`);
    parts.push(tableOpen());
    parts.push(thRow([
      { label: "Employee", align: "left" },
      { label: "Hours", align: "right" },
      { label: "Pay rate", align: "right" },
      { label: "Cost", align: "right" },
    ]));
    let totalCost = 0;
    let totalMin = 0;
    for (const t of hub.totalsByEmployee) {
      totalCost += t.cost;
      totalMin += t.minutes;
      parts.push(`<tr>
        ${td(t.employee)}
        ${td(fmtDuration(t.minutes), "right")}
        ${td(`$${t.payRate}/hr`, "right")}
        ${td(`$${t.cost.toFixed(2)}`, "right")}
      </tr>`);
    }
    parts.push(`<tr style="font-weight:700;background:${C.cyanBg};color:${C.primaryDk}">
      ${td("Total", "left", "border-bottom:none")}
      ${td(fmtDuration(totalMin), "right", "border-bottom:none")}
      ${td("", "right", "border-bottom:none")}
      ${td(`$${totalCost.toFixed(2)}`, "right", "border-bottom:none")}
    </tr>`);
    parts.push("</table>");
  }

  return sectionCard("Section 1 — Hubstaff (Hours & Activity)", parts.join("\n"));
}

// ---------- Section 2: Dispatcher Calls ----------

export function renderDispatcherSection(dispatch) {
  if (!dispatch) return sectionCard("Section 2 — Dispatcher Calls (GoHighLevel)", "<em>No data available.</em>");
  const parts = [];

  // Summary table — calls (≥25s) vs attempts (<25s) vs bookings
  if (dispatch.byDispatcher?.length) {
    parts.push(`<div style="font-size:13px;color:${C.textDim};margin:0 0 10px">
      <strong style="color:${C.text}">Calls</strong> = conversations ≥25 seconds. <strong style="color:${C.text}">Attempts</strong> = under 25 seconds.
    </div>`);
    parts.push(tableOpen());
    parts.push(thRow([
      { label: "Dispatcher", align: "left" },
      { label: "Calls", align: "right" },
      { label: "Attempts", align: "right" },
      { label: "Avg call", align: "right" },
      { label: "Bookings", align: "right" },
    ]));
    let totCalls = 0, totAttempts = 0, totBookings = 0;
    for (let i = 0; i < dispatch.byDispatcher.length; i++) {
      const d = dispatch.byDispatcher[i];
      const zebra = i % 2 === 1 ? `background:${C.zebra};` : "";
      totCalls += d.calls || 0;
      totAttempts += d.attempts || 0;
      totBookings += d.bookings || 0;
      parts.push(`<tr style="${zebra}">
        ${td(`<strong>${d.name}</strong>`)}
        ${td(d.calls ?? 0, "right")}
        ${td(d.attempts ?? 0, "right", `color:${C.textDim}`)}
        ${td(d.avgCallSec != null ? fmtSeconds(d.avgCallSec) : "—", "right")}
        ${td(d.bookings ?? 0, "right", `color:${C.primary};font-weight:600`)}
      </tr>`);
    }
    parts.push(`<tr style="font-weight:700;background:${C.cyanBg};color:${C.primaryDk}">
      ${td("Total", "left", "border-bottom:none")}
      ${td(totCalls, "right", "border-bottom:none")}
      ${td(totAttempts, "right", "border-bottom:none")}
      ${td("", "right", "border-bottom:none")}
      ${td(totBookings, "right", "border-bottom:none")}
    </tr>`);
    parts.push("</table>");
  }

  // Per-dispatcher hourly breakdown
  if (dispatch.byDispatcher?.some((d) => d.hourly?.length)) {
    parts.push(`<h3 style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${C.primaryDk};text-transform:uppercase;letter-spacing:.4px">Hourly breakdown</h3>`);
    for (const d of dispatch.byDispatcher) {
      if (!d.hourly?.length) continue;
      parts.push(`<div style="margin:0 0 14px">
        <div style="font-weight:600;color:${C.text};margin-bottom:6px">${d.name}</div>
        ${tableOpen()}
        ${thRow([
          { label: "Hour", align: "left" },
          { label: "Calls", align: "right" },
          { label: "Attempts", align: "right" },
        ])}`);
      for (let i = 0; i < d.hourly.length; i++) {
        const h = d.hourly[i];
        const zebra = i % 2 === 1 ? `background:${C.zebra};` : "";
        parts.push(`<tr style="${zebra}">
          ${td(h.label, "left", `color:${C.textDim};font-variant-numeric:tabular-nums`)}
          ${td(h.calls ?? 0, "right")}
          ${td(h.attempts ?? 0, "right", `color:${C.textDim}`)}
        </tr>`);
      }
      parts.push("</table></div>");
    }
  }

  // Time-of-day buckets (evening report only)
  if (dispatch.timeOfDay?.length) {
    parts.push(`<h3 style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${C.primaryDk};text-transform:uppercase;letter-spacing:.4px">Day in three parts</h3>`);
    parts.push(`<div style="display:table;width:100%;border-collapse:separate;border-spacing:8px 0;table-layout:fixed">`);
    for (const b of dispatch.timeOfDay) {
      const verdictColor = b.verdict === "good" ? C.green : b.verdict === "low" ? C.amber : C.text;
      const verdictBg = b.verdict === "good" ? C.greenBg : b.verdict === "low" ? C.amberBg : C.cyanBg;
      parts.push(`<div style="display:table-cell;width:33.3%;background:${verdictBg};border-radius:10px;padding:14px 14px;vertical-align:top">
        <div style="font-size:11px;color:${verdictColor};font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">${b.label}</div>
        <div style="font-size:11px;color:${C.textDim};margin-bottom:10px">${b.hours}</div>
        <table style="width:100%;font-size:13px">
          <tr><td style="color:${C.textDim};padding:2px 0">Calls</td><td style="text-align:right;padding:2px 0;font-weight:600">${b.calls ?? 0}</td></tr>
          <tr><td style="color:${C.textDim};padding:2px 0">Attempts</td><td style="text-align:right;padding:2px 0">${b.attempts ?? 0}</td></tr>
          <tr><td style="color:${C.textDim};padding:2px 0">Bookings</td><td style="text-align:right;padding:2px 0;font-weight:600;color:${C.primary}">${b.bookings ?? 0}</td></tr>
        </table>
        ${b.note ? `<div style="font-size:11px;color:${verdictColor};margin-top:8px;font-weight:600">${b.note}</div>` : ""}
      </div>`);
    }
    parts.push(`</div>`);
  }

  // New-lead response times
  if (dispatch.responseTimeAlerts?.length) {
    parts.push(`<h3 style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${C.primaryDk};text-transform:uppercase;letter-spacing:.4px">New-lead response times</h3>`);
    parts.push("<ul style='margin:0;padding-left:18px;font-size:14px;line-height:1.7'>");
    for (const a of dispatch.responseTimeAlerts) {
      const tag = a.late ? pill(`🔴 ${fmtDuration(a.delayMinutes)}`, "red") : pill(`✓ ${fmtDuration(a.delayMinutes)}`, "green");
      parts.push(`<li style="margin-bottom:4px">${tag}&nbsp; ${a.leadName} → ${a.dispatcher ?? "<em>no dispatcher</em>"}</li>`);
    }
    parts.push("</ul>");
  }

  // Appointments booked
  if (dispatch.appointmentsBooked?.length) {
    parts.push(`<h3 style="margin:18px 0 8px;font-size:13px;font-weight:600;color:${C.primaryDk};text-transform:uppercase;letter-spacing:.4px">Appointments booked / over-phone sales</h3>`);
    parts.push("<ul style='margin:0;padding-left:18px;font-size:14px;line-height:1.7'>");
    for (const a of dispatch.appointmentsBooked) {
      parts.push(`<li style="margin-bottom:4px"><strong>${a.leadName}</strong> @ ${a.time} — ${a.dispatcher} — <em style="color:${C.primary}">${a.stage}</em></li>`);
    }
    parts.push("</ul>");
  }

  return sectionCard("Section 2 — Dispatcher Calls (GoHighLevel)", parts.join("\n"));
}

// ---------- Email shell ----------

export function renderEmail({ title, generatedAt, sections }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};color:${C.text};-webkit-font-smoothing:antialiased">
  <div style="max-width:720px;margin:0 auto;padding:20px 14px">
    <!-- Header with logo on the left -->
    <table style="width:100%;border-collapse:collapse;margin-bottom:18px;background:linear-gradient(135deg,${C.primary} 0%,${C.primaryDk} 100%);border-radius:12px;overflow:hidden">
      <tr>
        <td style="padding:18px 20px;vertical-align:middle;width:64px">${LOGO_SVG}</td>
        <td style="padding:18px 20px 18px 0;vertical-align:middle">
          <div style="font-size:11px;color:${C.cyan};font-weight:700;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:2px">Local AC · Control Room</div>
          <div style="font-size:20px;color:${C.white};font-weight:700;line-height:1.2">${title}</div>
          <div style="color:#BFD7F0;font-size:12px;margin-top:4px">${fmtDate(generatedAt)} · generated ${generatedAt.toFormat("h:mm a ZZZZ")}</div>
        </td>
      </tr>
    </table>
    ${sections.join("\n")}
    <div style="text-align:center;color:${C.textDim};font-size:11px;margin-top:18px;line-height:1.6">
      Local AC Reports Bot · Hubstaff + GoHighLevel<br>
      <a href="https://controlroom.local-ac.com" style="color:${C.primary};text-decoration:none">controlroom.local-ac.com</a>
    </div>
  </div>
</body></html>`;
}

// ---------- Live alert ----------

export function renderLiveAlert({
  leadName,
  phone,
  leadAddedAt,
  minutesElapsed,
  level = 1,
  callSummary = null,
}) {
  const escalation = level >= 2;
  const dots = escalation ? "🔴🔴🔴" : "🔴";
  const tag = escalation ? "Escalation" : "Live alert";
  const headline = escalation
    ? `${dots} STILL not contacted after ${minutesElapsed} min`
    : `${dots} New lead not contacted in ${minutesElapsed} min`;

  // ----- Build the "what we saw" block -----
  let whatWeSaw;
  const calls = callSummary?.calls ?? [];
  if (calls.length === 0) {
    whatWeSaw = `<div style="color:${C.red};font-weight:600;font-size:14px">No outbound calls placed.</div>
        <div style="color:${C.textDim};font-size:12px;margin-top:4px">Automated texts don't count as a contact attempt.</div>`;
  } else {
    const list = calls
      .map((c) => {
        const dur = Math.max(0, Math.round(Number(c.duration) || 0));
        const isShort = dur < 20;
        const badge = isShort
          ? `<span style="color:${C.red};font-weight:600">short</span>`
          : `<span style="color:${C.green};font-weight:600">qualifying</span>`;
        const timeStr = c.at
          ? new Date(c.at).toLocaleTimeString("en-US", {
              hour: "numeric",
              minute: "2-digit",
              timeZone: "America/New_York",
            })
          : "—";
        const status = c.status ? ` · ${c.status}` : "";
        return `<li style="margin:3px 0">${dur}s — ${timeStr} ET ${badge}${status}</li>`;
      })
      .join("");
    const lead =
      callSummary.longCalls.length === 0 && callSummary.shortCalls.length === 1
        ? `<div style="color:${C.red};font-weight:600;font-size:14px">1 short call only — no qualifying attempt yet.</div>`
        : `<div style="color:${C.red};font-weight:600;font-size:14px">No qualifying call attempt detected.</div>`;
    whatWeSaw = `${lead}
        <ul style="margin:8px 0 0 0;padding-left:18px;color:${C.text};font-size:13px">${list}</ul>
        <div style="color:${C.textDim};font-size:11px;margin-top:8px">A "qualifying attempt" is one call ≥ 20 sec, or two+ short calls.</div>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:${C.redBg};font-family:${FONT};color:${C.text}">
  <div style="max-width:600px;margin:0 auto;padding:24px 18px">
    <table style="width:100%;border-collapse:collapse;margin-bottom:14px;background:${C.red};border-radius:12px;overflow:hidden">
      <tr>
        <td style="padding:14px 18px;vertical-align:middle;width:54px">${LOGO_SVG.replace('width="36"','width="32"').replace('height="44"','height="40"')}</td>
        <td style="padding:14px 18px 14px 0;vertical-align:middle;color:${C.white}">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.2px;opacity:.85">${tag}</div>
          <div style="font-size:18px;font-weight:700;line-height:1.2">${headline}</div>
        </td>
      </tr>
    </table>
    <div style="background:${C.white};border:1px solid ${C.border};border-radius:12px;padding:18px 22px">
      <table style="font-size:14px;width:100%">
        ${row("Lead", `<strong style="font-size:16px">${leadName}</strong>`)}
        ${row("Phone", `<a href="tel:${phone}" style="color:${C.red};font-weight:700;text-decoration:none">${phone}</a>`)}
        ${row("Lead came in", leadAddedAt)}
        ${row("Elapsed", `<strong style="color:${C.red}">${minutesElapsed} minutes</strong>`)}
      </table>
      <div style="margin-top:14px;padding-top:14px;border-top:1px solid ${C.border}">
        ${whatWeSaw}
      </div>
    </div>
    <p style="color:${C.textDim};font-size:12px;margin-top:14px;text-align:center">Local AC Reports Bot · live alert · <a href="https://controlroom.local-ac.com/alerts" style="color:${C.primary}">view all alerts</a></p>
  </div>
</body></html>`;
}

// ---------- Helpers ----------

function fmtSeconds(sec) {
  if (sec == null || isNaN(sec)) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}s`;
  return `${m}m ${s}s`;
}
