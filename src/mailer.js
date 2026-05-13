import nodemailer from "nodemailer";
import { config } from "./config.js";

const transporter = nodemailer.createTransport({
  host: config.smtp.host,
  port: config.smtp.port,
  secure: config.smtp.port === 465, // 465 is implicit TLS; 587 uses STARTTLS
  auth: {
    user: config.smtp.user,
    pass: config.smtp.password,
  },
});

// Ring buffer of recent send attempts. Exposed via /admin/send-history.
const SEND_HISTORY = [];
const SEND_HISTORY_MAX = 30;
function pushHistory(entry) {
  SEND_HISTORY.push({ ...entry, ts: new Date().toISOString() });
  while (SEND_HISTORY.length > SEND_HISTORY_MAX) SEND_HISTORY.shift();
}
export function getSendHistory() {
  return SEND_HISTORY.slice().reverse();
}

export async function verifyMailer() {
  await transporter.verify();
}

// attachments: [{ filename, content }] where content is Buffer | string | stream.
// Passed straight through to nodemailer — supports any of its attachment shapes.
export async function sendMail({ to, subject, html, text, attachments }) {
  const recipient = to ?? config.recipient;
  const from = `"${config.smtp.fromName}" <${config.smtp.fromAddress}>`;
  // attachment metadata for diagnostics
  const attMeta = (attachments || []).map((a) => ({
    filename: a?.filename || null,
    contentType: a?.contentType || null,
    contentBytes:
      a?.content && typeof a.content === "object" && "length" in a.content
        ? a.content.length
        : a?.content && typeof a.content === "string"
        ? a.content.length
        : null,
  }));
  try {
    const info = await transporter.sendMail({
      from,
      to: recipient,
      subject,
      html,
      text: text ?? (html ? html.replace(/<[^>]+>/g, " ") : ""), // crude fallback
      attachments,
    });
    pushHistory({
      to: recipient,
      from,
      subject,
      htmlLen: html ? html.length : 0,
      attachments: attMeta,
      ok: true,
      messageId: info?.messageId || null,
      response: info?.response || null,
      accepted: info?.accepted || null,
      rejected: info?.rejected || null,
    });
    return info;
  } catch (e) {
    pushHistory({
      to: recipient,
      from,
      subject,
      htmlLen: html ? html.length : 0,
      attachments: attMeta,
      ok: false,
      errorMessage: e?.message || String(e),
      errorCode: e?.code || null,
      errorCommand: e?.command || null,
      errorResponse: e?.response || null,
      errorResponseCode: e?.responseCode || null,
    });
    throw e;
  }
}
