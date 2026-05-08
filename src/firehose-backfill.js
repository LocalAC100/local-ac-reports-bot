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
          req.query.date || DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
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

  // GET /admin/debug/bucket-counts?date=YYYY-MM-DD&s=<JWT_BOOTSTRAP_SECRET>
  // Re-classify EXISTING calls table rows under the current classifyCall()
  // rule. No JWT, no HighLevel API call — pure DB query. This is how we
  // verify Change 1 (transfer detection) and Change 2 (70s threshold) — push
  // the new code, deploy, then hit this endpoint and the buckets recompute
  // from the raw_event JSON we already stored on backfill.
  //
  // Auth: secret-based bypass via ?s=<secret> using the same fixed secret as
  // the jwt-bootstrap endpoint (process.env.JWT_BOOTSTRAP_SECRET, default
  // "lac-jwt-2026-bootstrap-axabramov"). Read-only endpoint with no PII so
  // the secret-only gate is sufficient. Sessions get wiped on every Render
  // redeploy (in-memory store), so requireAdmin is too brittle for verifying
  // changes that themselves require deploying.
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
          req.query.date || DateTime.now().setZone(TZ).toFormat("yyyy-LL-dd");
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

  // GET /admin/debug/run-evening-report?date=YYYY-MM-DD&s=<secret>
  // GET /admin/debug/run-morning-report?date=YYYY-MM-DD&s=<secret>
  // Triggers the same orchestrators the cron jobs call, but lets us specify
  // a past date via dateOverride. Same secret-bypass auth as bucket-counts —
  // sessions get wiped on every Render redeploy so requireAdmin is too brittle
  // here (and the cron itself runs without auth, so this is closer to how
  // the real automated path works).
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
        await runEveningReport({ dateOverride });
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
        await runMorningReport({ dateOverride });
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

  return router;
}
