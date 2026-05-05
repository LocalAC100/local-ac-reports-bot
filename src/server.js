// HTTP server: receives GHL webhooks and exposes a /healthz check.
import express from "express";
import { config } from "./config.js";
import { onNewLead } from "./alerts.js";

export function buildServer() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  // GHL webhook: fired on contact.created, opportunity events, etc.
  
  Xeturn app;
}
