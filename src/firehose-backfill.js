// Firehose backfill router.
//
// Pulls outbound + inbound call rows from HighLevel's INTERNAL Call Reporting
// endpoint (the same one the dashboard's "Call Reporting" page uses) and
// persists them to the local 'calls' table via Calls.bulkUpsert. This is the
// nightly reconcile path that fills in any calls the live webhook missed.
//
// Auth: relies on a session JWT stashed at /var/data/ghl-internal-jwt.json by
// the bootstrap endpoint. JWTs expire ~1 hour after issuance — see
// task #64 for the long-term refresh story.
//
// Endpoints:
//   GET /admin/debug/firehose-backfill?date=YYYY-MM-DD
//     → Pulls both directions for the given date (default: today ET),
//       upserts into calls table, returns per-direction counts + 5-bucket
//       breakdown + per-user outbound rollup.
//   GET /admin/debug/bucket-counts?date=YYYY-MM-DD&s=<secret>
//     → Re-classifies existing rows under current classifyCall() rule.
//   GET /admin/debug/run-evening-report?date=YYYY-MM-DD&s=<secret>
//   GET /admin/debug/run-morning-report?date=YYYY-MM-DD&s=<secret>
//     → Triggers the cron orchestrators for an arbitrary date.
//   GET /admin/debug/build-excel?date=YYYY-MM-DD&s=<secret>&send=1
//     → Builds the daily Excel deliverable. With send=1, emails it to the
//       configured recipient. Without, streams the .xlsx for download.
//
// Mounted in server.js: app.use(buildFirehoseBackfillRouter()).

import express from "express";
import axios from "axios";
import fs from "fs";
import path from "path";
import { DateTime } from "luxon";
import { requireAdmin } from "./auth.js";
import { config } from "./config.js";
import { Calls, classifyCall } from "./db.js";
import { runMorningReport, runEveningReport } from "./reports.js";
import { buildDailyExcel } from "./excel-report.js";
import { sendMail } from "./mailer.js";
import * as ghl from "./ghl.js";

const TZ = "America/New_York";

function loadStoredJwt() {
  const dataDir = process.env.DATA_DIR || "/var/data";
  const file = path.join(dataDir, "ghl-internal-jwt.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

async function fetchFirehose({ date, direction, tokenId }) {
  const dayStart = DateTime.fromISO(date, { zone: TZ }).startOf("day");
  const dayEnd = dayStart.endOf("day");
  const body = {
    locationId: config.ghl.locationId,
    source: [],
    sourceType: [],
    keyword: [],
    landingPage: [],
    referrer: [],
    campaign: [],
    callStatus: [],
    dispositions: [],
    deviceType: [],
    qualifiedLead: false,
    firstTime: false,
    duration: null,
    selectedPool: "all",
    direction,
    startDate: dayStart.toUTC().toISO(),
    endDate: dayEnd.toUTC().toISO(),
    userId: "",
    limit: 1000,
    skip: 0,
  };
  const r = await axios.post(
    "https://backend.leadconnectorhq.com/reporting/calls/get-all-phone-calls-new",
    body,
    {
      headers: {
        "token-id": tokenId,
        channel: "APP",
        source: "WEB_USER",
        version: "2021-04-15",
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000,
    }
  );
  return r.data?.rows || [];
}

// Run a backfill for a specific date. Returns counts + per-user breakdown.
// Exported so the nightly cron job in index.js can call this directly.
export async function backfillDate(dateStr) {
  const jwt = loadStoredJwt();
  if (!jwt) throw new Error("no JWT stored — bootstrap one first");
  const tokenId = jwt["token-id"] || jwt.tokenId || jwt.accessToken;
  if (!tokenId) throw new Error("stored JWT has no token-id field");

  const [outRows, inRows] = await Promise.all([
    fetchFirehose({ date: dateStr, direction: "outbound", tokenId }),
    fetchFirehose({ date: dateStr, direction: "inbound", tokenId }),
  ]);

  const allRows = [...outRows, ...inRows];

  Calls.bulkUpsert(
    allRows.map((r) => ({
      callSid: r.callSid,
      direction: r.direction,
      status: r.callStatus,
      duration: r.duration,
      userId: r.userId || null,
      contactId: r.contactId,
      phone: r.from || r.to || null,
      source: "firehose",
      dateAdded: r.dateAdded,
      raw: r,
    }))
  );

  const buckets = {
    live_transfer: 0,
    real_call: 0,
    no_answer: 0,
    failed: 0,
    ringing: 0,
  };
  for (const r of allRows) {
    buckets[
      classifyCall({
        status: r.callStatus,
        duration: r.duration,
        participants: r.participants,
      })
    ]++;
  }

  const byUser = {};
  for (const r of outRows) {
    const u = r.userId || "(none)";
    byUser[u] = (byUser[u] || 0) + 1;
  }

  return {
    date: dateStr,
    outboundCount: outRows.length,
    inboundCount: inRows.length,
    totalSaved: allRows.length,
    buckets,
    byUserOutbound: byUser,
  };
}

export function buildFirehoseBackfillRouter() {
  const router = express.Router();

  router.get(
    "/admin/debug/firehose-backfill",
    requireAdmin,
    async (req, res) => {
      try {
        const dateStr =
          req.query.date ||
          DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
        const result = await backfillDate(dateStr);
        res.json({ ok: true, ...result });
      } catch (e) {
        res.status(500).json({
          ok: false,
          error: e?.message,
          stack: e?.stack,
        });
      }
    }
  );

  const VERIFY_SECRET =
    process.env.JWT_BOOTSTRAP_SECRET || "lac-jwt-2026-bootstrap-axabramov";

  router.get(
    "/admin/debug/bucket-counts",
    (req, res, next) => {
      if (req.query.s === VERIFY_SECRET) return next();
      return requireAdmin(req, res, next);
    },
    async (req, res) => {
      try {
        const dateStr =
          req.query.date ||
          DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
        const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
        const dayEnd = dayStart.endOf("day");
        const fromIso = dayStart.toUTC().toISO();
        const toIso = dayEnd.toUTC().toISO();

        const buckets = Calls.bucketCounts(fromIso, toIso);
        const totalOut = Calls.countInWindow(fromIso, toIso, "outbound");
        const totalIn = Calls.countInWindow(fromIso, toIso, "inbound");
        const byUser = Calls.byUserCount(fromIso, toIso, "outbound");

        res.json({
          ok: true,
          date: dateStr,
          window: { fromIso, toIso },
          totals: {
            outbound: totalOut,
            inbound: totalIn,
            both: totalOut + totalIn,
          },
          buckets,
          byUserOutbound: Object.fromEntries(
            byUser.map((r) => [r.user_id || "(none)", r.n])
          ),
        });
      } catch (e) {
        res
          .status(500)
          .json({ ok: false, error: e?.message, stack: e?.stack });
      }
    }
  );

  function secretBypass(req, res, next) {
    if (req.query.s === VERIFY_SECRET) return next();
    return requireAdmin(req, res, next);
  }

  router.get(
    "/admin/debug/run-evening-report",
    secretBypass,
    async (req, res) => {
      const t0 = Date.now();
      try {
        const dateOverride = req.query.date || undefined;
        await runEveningReport({ dateOverride, to: req.query.to });
        res.json({
          ok: true,
          kind: "evening-report",
          dateOverride: dateOverride || "(now)",
          durationMs: Date.now() - t0,
        });
      } catch (e) {
        res.status(500).json({
          ok: false,
          kind: "evening-report",
          error: e?.message,
          stack: e?.stack,
        });
      }
    }
  );

  router.get(
    "/admin/debug/run-morning-report",
    secretBypass,
    async (req, res) => {
      const t0 = Date.now();
      try {
        const dateOverride = req.query.date || undefined;
        await runMorningReport({ dateOverride, to: req.query.to });
        res.json({
          ok: true,
          kind: "morning-report",
          dateOverride: dateOverride || "(now)",
          durationMs: Date.now() - t0,
        });
      } catch (e) {
        res.status(500).json({
          ok: false,
          kind: "morning-report",
          error: e?.message,
          stack: e?.stack,
        });
      }
    }
  );

  // GET /admin/debug/build-excel?date=YYYY-MM-DD&s=<secret>&send=1
  // Builds the daily Excel deliverable. With send=1, emails it to the
  // configured recipient. Without, streams the .xlsx for download.
  router.get(
    "/admin/debug/build-excel",
    secretBypass,
    async (req, res) => {
      const t0 = Date.now();
      try {
        const dateStr =
          req.query.date ||
          DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
        const send = req.query.send === "1" || req.query.send === "true";

        const { filename, buffer } = await buildDailyExcel(dateStr);

        if (send) {
          const subject = `Local AC — Daily Report (${dateStr}) [Excel attached]`;
          const html = `
            <p>Local AC daily call activity for <b>${dateStr}</b> — see attached spreadsheet for the full breakdown.</p>
            <p>Tabs: Summary, All Calls, New Leads, By Dispatcher, By Pipeline, By Pipeline Stage, By Lead Age, Hourly, By Outbound #, Hour x Dispatcher, Notes.</p>
            <p style="color:#666;font-size:12px">This is a dryrun email triggered via /admin/debug/build-excel. Once Alex confirms the format, this attachment will be added to the regular morning + evening report emails.</p>
          `;
          await sendMail({
            subject,
            html,
            attachments: [{ filename, content: Buffer.from(buffer) }],
          });
          res.json({
            ok: true,
            sent: true,
            filename,
            sizeBytes: buffer.byteLength || buffer.length,
            sentTo: config.recipient,
            durationMs: Date.now() - t0,
          });
        } else {
          res.set({
            "Content-Type":
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "Content-Disposition": `attachment; filename="${filename}"`,
            "Content-Length": String(buffer.byteLength || buffer.length),
          });
          res.send(Buffer.from(buffer));
        }
      } catch (e) {
        console.error("[build-excel] failed", e);
        res.status(500).json({
          ok: false,
          error: e?.message,
          stack: e?.stack,
        });
      }
    }
  );


  // GET /admin/debug/inspect-leads?date=YYYY-MM-DD&s=<secret>
  // Diagnostic: dump every contact whose dateAdded falls on the given date,
  // showing the raw source field value. Used to figure out which source
  // strings GHL actually returns (so the New Leads filter in excel-report.js
  // can match them). No filtering — returns everything as-is.
  router.get(
    "/admin/debug/inspect-leads",
    secretBypass,
    async (req, res) => {
      try {
        const dateStr =
          req.query.date ||
          DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
        const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
        const dayEnd = dayStart.endOf("day");
        const fromIso = dayStart.toUTC().toISO();
        const toIso = dayEnd.toUTC().toISO();

        // Pull every contact_id that had a call on this date — direct DB query.
        const rows = Calls.listInWindow(fromIso, toIso, 5000);
        const ids = [...new Set(rows.map((r) => r.contact_id).filter(Boolean))];

        // Try GHL searchContacts as a secondary source. If it 422s, swallow and
        // continue — we still want the per-call contacts.
        let searchResults = [];
        let searchError = null;
        try {
          searchResults = await ghl.searchContacts({ from: fromIso, to: toIso, limit: 100 });
        } catch (e) {
          searchError = e?.response?.data || e?.message;
        }
        const searchById = new Map();
        for (const c of searchResults || []) if (c?.id) searchById.set(c.id, c);

        // Fetch each call-contact in parallel
        const fetched = [];
        const CONCURRENCY = 8;
        let i = 0;
        async function worker() {
          while (i < ids.length) {
            const id = ids[i++];
            try {
              const c = await ghl.getContact(id);
              if (c) fetched.push(c);
            } catch (e) {}
          }
        }
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));

        // Combine: prefer search results, fall back to fetched
        const byId = new Map();
        for (const c of fetched) if (c?.id) byId.set(c.id, c);
        for (const c of searchById.values()) byId.set(c.id, c);

        // Filter to contacts whose dateAdded falls on the report day
        const todayContacts = [];
        for (const c of byId.values()) {
          if (!c.dateAdded) continue;
          const t = new Date(c.dateAdded).getTime();
          if (t < new Date(fromIso).getTime() || t > new Date(toIso).getTime()) continue;
          todayContacts.push({
            id: c.id,
            name: `${c.firstName || ""} ${c.lastName || ""}`.trim() || c.contactName || "",
            phone: c.phone,
            source: c.source,
            sourceType: c.sourceType,
            tags: c.tags,
            dateAdded: c.dateAdded,
            fromSearch: searchById.has(c.id),
          });
        }

        const sourceCounts = {};
        for (const c of todayContacts) {
          const k = c.source || "(no source)";
          sourceCounts[k] = (sourceCounts[k] || 0) + 1;
        }

        res.json({
          ok: true,
          date: dateStr,
          window: { fromIso, toIso },
          uniqueContactIdsInCalls: ids.length,
          fetchedFromGetContact: fetched.length,
          fetchedFromSearch: searchResults.length,
          searchError,
          todayContactsCount: todayContacts.length,
          sourceCounts,
          contacts: todayContacts,
        });
      } catch (e) {
        res.status(500).json({
          ok: false,
          error: e?.message,
          stack: e?.stack,
        });
      }
    }
  );


  // GET /admin/debug/inspect-opps?date=YYYY-MM-DD&s=<secret>
  // Diagnostic: dump every opportunity returned by searchOpportunities across
  // all pipelines, with all of its fields. Used to figure out the real field
  // name for opportunity creation timestamp (createdAt vs dateAdded vs other).
  router.get(
    "/admin/debug/inspect-opps",
    secretBypass,
    async (req, res) => {
      try {
        const dateStr =
          req.query.date ||
          DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
        const dayStart = DateTime.fromISO(dateStr, { zone: TZ }).startOf("day");
        const dayEnd = dayStart.endOf("day");
        const fromIso = dayStart.toUTC().toISO();
        const toIso = dayEnd.toUTC().toISO();

        const pipelines = await ghl.listPipelines();
        const allOpps = [];
        for (const p of pipelines) {
          try {
            const opps = await ghl.searchOpportunities({ pipelineId: p.id, limit: 100 });
            for (const o of opps) {
              allOpps.push({ pipelineName: p.name, ...o });
            }
          } catch (e) {
            allOpps.push({ pipelineName: p.name, error: e?.message });
          }
        }

        // Identify any timestamp-like field on the first opp so we can see what's available
        const sampleKeys = allOpps.length ? Object.keys(allOpps[0]) : [];

        // Find opps with any timestamp on the report day
        const matches = [];
        for (const o of allOpps) {
          for (const k of Object.keys(o)) {
            const v = o[k];
            if (typeof v !== "string") continue;
            if (!v.match(/^\d{4}-\d{2}-\d{2}T/)) continue;
            const t = new Date(v).getTime();
            if (t >= new Date(fromIso).getTime() && t <= new Date(toIso).getTime()) {
              matches.push({ field: k, value: v, oppId: o.id, contactId: o.contactId, name: o.name, pipeline: o.pipelineName, stage: o.pipelineStageName });
              break;
            }
          }
        }

        res.json({
          ok: true,
          totalOpps: allOpps.length,
          sampleKeys,
          firstOpp: allOpps[0] || null,
          matchesOnReportDay: matches.length,
          matches: matches.slice(0, 30),
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
      }
    }
  );


  // GET /admin/debug/send-mockup?to=<email>&s=<secret>
  // Sends the static HTML mockup of the new daily-report email format. Lets
  // Alex preview the new layout in Gmail. Reads from src/email-mockup.html.
  router.get(
    "/admin/debug/send-mockup",
    secretBypass,
    async (req, res) => {
      try {
        const to = req.query.to || undefined;
        const fs = await import("fs");
        const path = await import("path");
        const fileURL = new URL("./email-mockup.html", import.meta.url);
        const html = fs.readFileSync(fileURL, "utf8");
        await sendMail({
          to,
          subject: "Local AC — NEW REPORT FORMAT MOCKUP (May 7)",
          html,
        });
        res.json({
          ok: true,
          subject: "Local AC — NEW REPORT FORMAT MOCKUP (May 7)",
          sentTo: to || config.recipient,
          bytes: html.length,
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
      }
    }
  );


  // GET /admin/debug/check-alert?contact_id=<id>&leadAddedAt=<ISO>&s=<secret>
  // Inspects what the live-alert system sees for a given contact + leadAddedAt.
  // Useful for verifying suppression logic without waiting 3-10 min for a
  // timer to fire on a real lead.
  router.get(
    "/admin/debug/check-alert",
    secretBypass,
    async (req, res) => {
      try {
        const { _internal } = await import("./alerts.js");
        const contactId = req.query.contact_id;
        const leadAddedAt = req.query.leadAddedAt || new Date().toISOString();
        if (!contactId) {
          res.status(400).json({ ok: false, error: "missing contact_id" });
          return;
        }
        const local = _internal.checkSuppressionLocal(contactId, leadAddedAt);
        let ghl = null;
        if (local.totalAttempts === 0) {
          ghl = await _internal.checkSuppressionGHL(contactId, leadAddedAt);
        }
        const decision = ghl || local;
        res.json({
          ok: true,
          contactId,
          leadAddedAt,
          wouldSuppress: decision.attempted,
          decisionSource: decision._source,
          local,
          ghlFallback: ghl,
        });
      } catch (e) {
        res.status(500).json({ ok: false, error: e?.message, stack: e?.stack });
      }
    }
  );

    // Diagnostic alias of /admin/debug/firehose-backfill that uses secret-bypass auth.
  // Lets diagnostic tooling kick off a manual backfill without the control-room session.
  router.get("/admin/debug/run-firehose", secretBypass, async (req, res) => {
    try {
      const dateStr = req.query.date || new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
      const result = await backfillDate(dateStr);
      res.json({ ok: true, date: dateStr, result });
    } catch (e) {
      res.json({ ok: false, error: (e && e.message) || String(e), stack: ((e && e.stack) || "").slice(0, 1200) });
    }
  });

  // Diagnostic: status of the GHL internal JWT file (mtime + size only, never content).
  router.get("/admin/debug/jwt-status", secretBypass, async (req, res) => {
    try {
      const fs = await import("node:fs");
      const stat = fs.statSync("/var/data/ghl-internal-jwt.json");
      res.json({ ok: true, exists: true, sizeBytes: stat.size, mtime: stat.mtime.toISOString(), ageSeconds: Math.floor((Date.now() - stat.mtime.getTime()) / 1000) });
    } catch (e) {
      res.json({ ok: true, exists: false, error: (e && e.message) || String(e) });
    }
  });

return router;
}
// =====================================================================
// JWT auto-refresh: exchange Firebase refresh token for fresh access token
// =====================================================================
export async function refreshStoredJwt() {
  const stored = loadStoredJwt();
  if (!stored || !stored.refreshToken || !stored.apiKey) {
    throw new Error("refreshStoredJwt: stored JWT missing refreshToken or apiKey");
  }
  const fbResp = await axios.post(
    "https://securetoken.googleapis.com/v1/token?key=" + stored.apiKey,
    "grant_type=refresh_token&refresh_token=" + encodeURIComponent(stored.refreshToken),
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );
  const newTok = fbResp.data.id_token || fbResp.data.access_token;
  const updated = {
    ...stored,
    tokenId: newTok,
    accessToken: newTok,
    refreshToken: fbResp.data.refresh_token || stored.refreshToken,
    expiresAt: Date.now() + (parseInt(fbResp.data.expires_in, 10) * 1000),
    savedAt: new Date().toISOString(),
  };
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dataDir = process.env.DATA_DIR || "/var/data";
  const file = path.default.join(dataDir, "ghl-internal-jwt.json");
  fs.default.mkdirSync(dataDir, { recursive: true });
  fs.default.writeFileSync(file, JSON.stringify(updated, null, 2), "utf8");
  console.log("[jwt-refresh] refreshed at", updated.savedAt, "expiresAt", new Date(updated.expiresAt).toISOString());
  return { ok: true, expiresIn: parseInt(fbResp.data.expires_in, 10), savedAt: updated.savedAt, expiresAt: updated.expiresAt };
}
