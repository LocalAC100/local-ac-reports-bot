// Live alert: when a new lead comes in via the GHL webhook, start a 3-minute
// timer. If the dispatcher hasn't called by then, fire an email alert AND
// log it to the dashboard alerts feed.
import { config } from "./config.js";
import * as ghl from "./ghl.js";
import { sendMail } from "./mailer.js";
import { renderLiveAlert } from "./template.js";
import { fmtDateTime } from "./time.js";
import { Alerts } from "./db.js";
import { DateTime } from "luxon";

const pendingTimers = new Map(); // contactId -> NodeJS.Timeout

export async function onNewLead({ contactId, contactName, phone, leadAddedAt }) {
  if (!contactId) return;
  if (pendingTimers.has(contactId)) return;

  const thresholdMs = config.leadResponseThresholdMinutes * 60 * 1000;

  const timer = setTimeout(async () => {
    pendingTimers.delete(contactId);
    try {
      // Re-check at threshold: did anyone call them?
      const conversations = await ghl
        .searchConversations({
          from: new Date(leadAddedAt).toISOString(),
          to: new Date().toISOString(),
        })
        .catch(() => []);
      const conv = conversations.find((c) => c.contactId === contactId);
      if (conv) {
        const msgs = await ghl.getConversationMessages(conv.id).catch(() => []);
        const called = msgs.some(
          (m) =>
            String(m.type ?? "").toUpperCase() === "CALL" &&
            String(m.direction ?? "").toLowerCase() === "outbound"
        );
        if (called) return;
      }

      const elapsed = Math.round(
        (Date.now() - new Date(leadAddedAt).getTime()) / 60000
      );

      // Log to dashboard alerts table
      try {
        Alerts.log({
          contactId,
          contactName: contactName || null,
          phone: phone || null,
          leadAddedAt: leadAddedAt || null,
          minutesElapsed: elapsed,
        });
      } catch (e) {
        console.error("[live-alert] db log failed", e?.message);
      }

      // Send email
      const html = renderLiveAlert({
        leadName: contactName || "(unnamed lead)",
        phone: phone || "(no phone)",
        leadAddedAt: fmtDateTime(DateTime.fromJSDate(new Date(leadAddedAt))),
        minutesElapsed: elapsed,
      });
      await sendMail({
        subject: `🔴 New lead not contacted in ${elapsed} min — ${contactName ?? "lead"}`,
        html,
      });
    } catch (e) {
      console.error("[live-alert] failed", e?.message);
    }
  }, thresholdMs);

  pendingTimers.set(contactId, timer);
}
