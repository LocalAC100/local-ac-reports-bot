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
        transferred: r.transferred,
        isTransferred: r.isTransferred,
        dispositions: r.dispositions,
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

  return router;
}
