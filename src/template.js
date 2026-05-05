// HTML email template. Mobile-first, inline styles only (most email clients
// strip <style> tags), red for flagged items, green for clean items.
import { fmtDate, fmtDuration } from "./time.js";

const COLOR = {
  red: "#c0392b",
  redBg: "#fdecea",
  green: "#1e7e34",
  greenBg: "#e6f4ea",
  amber: "#a86d00",
  amberBg: "#fff4d6",
  text: "#222",
  textDim: "#555",
  border: "#dfe3e8",
  bg: "#f6f7f9",
  white: "#ffffff",
};

function flag(text, color = "red") {
  const fg = COLOR[color] ?? COLOR.red;
  const bg = COLOR[`${color}Bg`] ?? COLOR.redBg;
  return `<span style="background:${bg};color:${fg};padding:2px 6px;border-radius:4px;font-weight:600;font-size:13px">${text}</span>`;
}

function row(label, value) {
  return `<tr><td style="padding:4px 8px 4px 0;color:${COLOR.textDim};vertical-align:top">${label}</td><td style="padding:4px 0;color:${COLOR.text};vertical-align:top">${value}</td></tr>`;
}

function section(title, body) {
  return `
  <div style="background:${COLOR.white};border:1px solid ${COLOR.border};border-radius:8px;padding:16px 20px;margin-bottom:14px">
    <h2 style="margin:0 0 12px;font-size:17px;color:${COLOR.text}">${title}</h2>
    ${body}
  </div>`;
}

export function renderHubstaffSection(hub) {
  if (!hub) return section("Hubstaff", "<em>No data available.</em>");
  const parts = [];

  if (hub.allClean) {
    parts.push(`<div style="color:${COLOR.green};font-weight:600">${flag("✓ No discrepancy in hours – office employees", "green")}</div>`);
  } else if (hub.discrepancies?.length) {
    parts.push(`<div style="margin-bottom:10px">${flag(`⚠ ${hub.discrepancies.length} discrepanc${hub.discrepancies.length === 1 ? "y" : "ies"}`, "red")}</div>`);
    parts.push("<ul style='margin:0 0 12px;padding-left:20px'>");
    for (const d of hub.discrepancies) {
      parts.push(`<li style="margin-bottom:6px"><strong>${d.employee}:</strong> ${d.detail}</li>`);
    }
    parts.push("</ul>");
  }

  if (hub.activitySummary?.length) {
    parts.push("<h3 style='margin:14px 0 6px;font-size:14px'>Activity %</h3>");
    parts.push("<table style='width:100%;border-collapse:collapse;font-size:14px'>");
    parts.push(`<tr style="background:${COLOR.bg}"><th style='text-align:left;padding:6px 8px'>Employee</th><th style='text-align:right;padding:6px 8px'>Avg %</th><th style='text-align:left;padding:6px 8px'>Hourly breakdown</th></tr>`);
    for (const a of hub.activitySummary) {
      const hourly = (a.hourly || [])
        .map((h) => {
          const cls =
            h.flagged ? `style="color:${COLOR.red};font-weight:600"` : "";
          return `<span ${cls}>${h.hour}: ${h.pct}%</span>`;
        })
        .join("&nbsp;&nbsp;");
      parts.push(`<tr><td style='padding:6px 8px'>${a.employee}</td><td style='text-align:right;padding:6px 8px'>${a.avgPct}%</td><td style='padding:6px 8px;font-size:12px'>${hourly}</td></tr>`);
    }
    parts.push("</table>");
  }

  if (hub.lowActivityFlags?.length) {
    parts.push("<h3 style='margin:14px 0 6px;font-size:14px'>Low-activity flags</h3>");
    parts.push("<ul style='margin:0 0 8px;padding-left:20px'>");
    for (const f of hub.lowActivityFlags) {
      const tag = f.alsoLowCalls ? flag("🔴 LOW ACTIVITY + LOW CALLS", "red") : flag("⚠ Low activity", "amber");
      parts.push(`<li style="margin-bottom:4px">${tag}&nbsp; <strong>${f.employee}</strong> at ${f.hour} — ${f.detail}</li>`);
    }
    parts.push("</ul>");
  }

  if (hub.manipulationFlags?.length) {
    parts.push("<h3 style='margin:14px 0 6px;font-size:14px'>Screenshot manipulation watch</h3>");
    parts.push("<ul style='margin:0;padding-left:20px'>");
    for (const f of hub.manipulationFlags) {
      parts.push(`<li style="margin-bottom:6px">${flag("🔴 POSSIBLE MANIPULATION", "red")} <strong>${f.employee}</strong> ${f.windowLabel}: ${f.reason}</li>`);
    }
    parts.push("</ul>");
  } else if (hub.activitySummary?.length) {
    parts.push(`<div style="margin-top:8px">${flag("✓ No screenshot manipulation patterns detected", "green")}</div>`);
  }

  if (hub.totalsByEmployee?.length) {
    parts.push("<h3 style='margin:14px 0 6px;font-size:14px'>Total hours worked</h3>");
    parts.push("<table style='width:100%;border-collapse:collapse;font-size:14px'>");
    parts.push(`<tr style="background:${COLOR.bg}"><th style='text-align:left;padding:6px 8px'>Employee</th><th style='text-align:right;padding:6px 8px'>Hours</th><th style='text-align:right;padding:6px 8px'>Pay-rate</th><th style='text-align:right;padding:6px 8px'>Cost</th></tr>`);
    let totalCost = 0;
    for (const t of hub.totalsByEmployee) {
      totalCost += t.cost;
      parts.push(`<tr><td style='padding:6px 8px'>${t.employee}</td><td style='text-align:right;padding:6px 8px'>${fmtDuration(t.minutes)}</td><td style='text-align:right;padding:6px 8px'>$${t.payRate}/hr</td><td style='text-align:right;padding:6px 8px'>$${t.cost.toFixed(2)}</td></tr>`);
    }
    parts.push(`<tr style="font-weight:700"><td style='padding:6px 8px'>Total</td><td></td><td></td><td style='text-align:right;padding:6px 8px'>$${totalCost.toFixed(2)}</td></tr>`);
    parts.push("</table>");
  }

  return section("Section 1 — Hubstaff (Hours & Activity)", parts.join("\n"));
}

export function renderDispatcherSection(dispatch) {
  if (!dispatch) return section("Dispatcher Calls", "<em>No data available.</em>");
  const parts = [];

  if (dispatch.byDispatcher?.length) {
    parts.push("<table style='width:100%;border-collapse:collapse;font-size:14px'>");
    parts.push(`<tr style="background:${COLOR.bg}"><th style='text-align:left;padding:6px 8px'>Dispatcher</th><th style='text-align:right;padding:6px 8px'>Total calls</th><th style='text-align:right;padding:6px 8px'>&lt;25s</th><th style='text-align:right;padding:6px 8px'>&ge;25s</th><th style='text-align:right;padding:6px 8px'>Bookings</th></tr>`);
    for (const d of dispatch.byDispatcher) {
      parts.push(`<tr><td style='padding:6px 8px'>${d.name}</td><td style='text-align:right;padding:6px 8px'>${d.total}</td><td style='text-align:right;padding:6px 8px'>${d.under25}</td><td style='text-align:right;padding:6px 8px'>${d.over25}</td><td style='text-align:right;padding:6px 8px'>${d.bookings}</td></tr>`);
    }
    parts.push("</table>");
  }

  if (dispatch.responseTimeAlerts?.length) {
    parts.push("<h3 style='margin:14px 0 6px;font-size:14px'>New-lead response times</h3>");
    parts.push("<ul style='margin:0;padding-left:20px'>");
    for (const a of dispatch.responseTimeAlerts) {
      const tag = a.late ? flag(`🔴 ${fmtDuration(a.delayMinutes)}`, "red") : flag(`✓ ${fmtDuration(a.delayMinutes)}`, "green");
      parts.push(`<li style="margin-bottom:4px">${tag} ${a.leadName} → ${a.dispatcher ?? "no dispatcher"}</li>`);
    }
    parts.push("</ul>");
  }

  if (dispatch.appointmentsBooked?.length) {
    parts.push("<h3 style='margin:14px 0 6px;font-size:14px'>Appointments booked</h3>");
    parts.push("<ul style='margin:0;padding-left:20px'>");
    for (const a of dispatch.appointmentsBooked) {
      parts.push(`<li style="margin-bottom:4px"><strong>${a.leadName}</strong> @ ${a.time} — ${a.dispatcher} — <em>${a.stage}</em></li>`);
    }
    parts.push("</ul>");
  }

  return section("Section 2 — Dispatcher Calls (GoHighLevel)", parts.join("\n"));
}

export function renderEmail({ title, generatedAt, sections }) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${COLOR.bg};font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:${COLOR.text}">
  <div style="max-width:680px;margin:0 auto;padding:18px 14px">
    <h1 style="font-size:20px;margin:0 0 4px">${title}</h1>
    <div style="color:${COLOR.textDim};font-size:13px;margin-bottom:14px">${fmtDate(generatedAt)} · generated ${generatedAt.toFormat("h:mm a ZZZZ")}</div>
    ${sections.join("\n")}
    <div style="text-align:center;color:${COLOR.textDim};font-size:11px;margin-top:18px">Local AC Reports Bot · automated from Hubstaff + GoHighLevel</div>
  </div>
</body></html>`;
}

export function renderLiveAlert({ leadName, phone, leadAddedAt, minutesElapsed }) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:${COLOR.redBg};font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 18px">
    <h1 style="color:${COLOR.red};font-size:22px;margin:0 0 12px">🔴 New lead not contacted in ${minutesElapsed} minutes</h1>
    <div style="background:${COLOR.white};border:2px solid ${COLOR.red};border-radius:8px;padding:16px 20px">
      <table style="font-size:15px">
        ${row("Lead", `<strong>${leadName}</strong>`)}
        ${row("Phone", `<a href="tel:${phone}" style="color:${COLOR.red};font-weight:600">${phone}</a>`)}
        ${row("Lead came in", leadAddedAt)}
        ${row("Elapsed with no call", `<strong style="color:${COLOR.red}">${minutesElapsed} minutes</strong>`)}
      </table>
    </div>
    <p style="color:${COLOR.text};font-size:13px;margin-top:16px">Local AC Reports Bot · live alert</p>
  </div>
</body></html>`;
}
