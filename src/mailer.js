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

export async function verifyMailer() {
  await transporter.verify();
}

export async function sendMail({ to, subject, html, text }) {
  return transporter.sendMail({
    from: `"${config.smtp.fromName}" <${config.smtp.fromAddress}>`,
    to: to ?? config.recipient,
    subject,
    html,
    text: text ?? html.replace(/<[^>]+>/g, " "), // crude fallback
  });
}
