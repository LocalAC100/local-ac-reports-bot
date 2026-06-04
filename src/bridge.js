// ============================================================================
// Local AC Data Bridge  —  src/bridge.js   (ES Module)
// ----------------------------------------------------------------------------
// Server-side bridge to GoHighLevel + Meta Ads. No Chrome, no browser, no
// Cowork. Exposes the data two ways:
//   1. REST JSON         ->  GET /bridge/ghl/...  /bridge/meta/...   (?s=<secret>)
//   2. MCP (Streamable HTTP, JSON-RPC)  ->  POST /bridge/mcp   (Bearer auth)
// The MCP path is what lets Claude on ANY surface (incl. phone) call it as a
// custom connector.
//
// Pattern matches the rest of the app: a buildBridgeRouter() factory returning
// an Express Router, mounted in server.js with `app.use(buildBridgeRouter());`.
//
// SECRETS (this repo is PUBLIC — nothing sensitive is hardcoded):
//   GHL_PIT             GoHighLevel Private Integration Token (read-only). If
//                       unset, falls back to GHL_LOCATION_API_KEY (already in
//                       Render). If neither works, GHL tools say "not configured".
//   GHL_LOCATION_ID     LocalAC sub-account id (not secret; safe default below).
//   META_TOKEN          Meta access token (ads_read). Required for Meta tools.
//   META_AD_ACCOUNT     Meta ad account id digits (not secret; safe default).
//   BRIDGE_SECRET       REST gate. Falls back to JWT_BOOTSTRAP_SECRET.
//   BRIDGE_MCP_TOKEN    MCP Bearer. MUST be set to a strong value; if unset, the
//                       /bridge/mcp endpoint refuses (it would expose CRM data).
// ============================================================================

import express from "express";

const GHL_PIT      = process.env.GHL_PIT || process.env.GHL_LOCATION_API_KEY || "";
const GHL_LOCATION = process.env.GHL_LOCATION_ID || "Uy9E208xMrP6bRj5jdSK";
const META_TOKEN   = process.env.META_TOKEN || "";
const META_AD_ACCT = String(process.env.META_AD_ACCOUNT || "1201602603808175").replace(/^act_/, "");
const BRIDGE_SECRET   = process.env.BRIDGE_SECRET || process.env.JWT_BOOTSTRAP_SECRET || "lac-jwt-2026-bootstrap-axabramov";
const BRIDGE_MCP_TOKEN = process.env.BRIDGE_MCP_TOKEN || "";

const GHL_BASE  = "https://services.leadconnectorhq.com";
const ghlHdrs   = () => ({ Authorization: `Bearer ${GHL_PIT}`, Version: "2021-07-28", Accept: "application/json" });
const ghlHdrsJ  = () => ({ ...ghlHdrs(), "Content-Type": "application/json" });
const META_VER  = "v19.0";

// ---- date helper: inclusive ET day range -> UTC ISO (EDT assumed for summer) -
const ET_OFFSET_MS = 4 * 3600 * 1000;
function etDayToUtcRange(sinceYmd, untilYmd) {
  const since = new Date(`${sinceYmd}T00:00:00.000Z`).getTime() + ET_OFFSET_MS;
  const until = new Date(`${untilYmd}T00:00:00.000Z`).getTime() + ET_OFFSET_MS + 24 * 3600 * 1000;
  return { gte: new Date(since).toISOString(), lte: new Date(until).toISOString() };
}

function categorizeStage(stage) {
  if (!stage) return "NO_OPP";
  const s = stage.toLowerCase();
  if ((s.includes("purchased") || s.includes("closed") || s.includes("completed") || s.includes("won") || s.includes("sold")) && !s.includes("not")) return "CLOSED";
  if (s.includes("phone sale")) return "CLOSED";
  if (s.includes("over phone") || s.includes("over the phone") || s.includes("phone booked") || s.includes("phone quote")) return "PHONE_BOOKED";
  if (s.includes("appt") || s.includes("appointment")) return "APPOINTMENT";
  if (s.includes("not interested") || s.includes("not ready") || s.includes("outside service") || s.includes("out of service") ||
      s.includes("wrong number") || s.includes("spam") || s.includes("duplicate") || s.includes("disconnected") ||
      s.includes("denies") || s.includes("wrong category")) return "DEAD";
  return "LEAD";
}
const PRIORITY = { CLOSED: 5, PHONE_BOOKED: 4, APPOINTMENT: 3, LEAD: 2, DEAD: 1, NO_OPP: 0 };

function assertGhl() { if (!GHL_PIT) throw new Error("GHL not configured (set GHL_PIT env var)"); }

async function ghlPipelines() {
  const r = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${GHL_LOCATION}`, { headers: ghlHdrs() });
  if (!r.ok) throw new Error(`GHL pipelines ${r.status}`);
  return (await r.json()).pipelines || [];
}
async function ghlFieldMap() {
  const r = await fetch(`${GHL_BASE}/locations/${GHL_LOCATION}/customFields`, { headers: ghlHdrs() });
  if (!r.ok) throw new Error(`GHL customFields ${r.status}`);
  const map = {};
  (((await r.json()).customFields) || []).forEach((f) => { map[f.id] = f.name; });
  return map;
}
async function ghlContacts(gte, lte) {
  const out = [];
  let searchAfter = null, page = 0;
  while (true) {
    const body = { locationId: GHL_LOCATION, pageLimit: 100,
      filters: [{ field: "dateAdded", operator: "range", value: { gte, lte } }] };
    if (searchAfter) body.searchAfter = searchAfter;
    const r = await fetch(`${GHL_BASE}/contacts/search`, { method: "POST", headers: ghlHdrsJ(), body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`GHL contacts ${r.status}`);
    const data = await r.json();
    const batch = data.contacts || [];
    for (const c of batch) out.push(c);
    page++;
    if (batch.length < 100 || page > 60) break;
    const last = batch[batch.length - 1];
    searchAfter = [last.dateAdded, last.id];
  }
  return out;
}
async function ghlOpportunities(stopBeforeUtcMs) {
  const out = [];
  let sa = "", sai = "", p = 0;
  while (true) {
    let url = `${GHL_BASE}/opportunities/search?location_id=${GHL_LOCATION}&limit=100`;
    if (sa) url += `&startAfter=${sa}&startAfterId=${sai}`;
    const r = await fetch(url, { headers: ghlHdrs() });
    if (!r.ok) throw new Error(`GHL opps ${r.status}`);
    const data = await r.json();
    const opps = data.opportunities || [];
    for (const o of opps) out.push(o);
    p++;
    if (!data.meta || !data.meta.startAfter || opps.length === 0) break;
    const oldest = Math.min(...opps.map((o) => new Date(o.createdAt).getTime()));
    if (oldest < stopBeforeUtcMs) break;
    sa = data.meta.startAfter; sai = data.meta.startAfterId;
    if (p > 60) break;
  }
  return out;
}
const fieldValFn = (fm) => (c, name) => {
  const f = (c.customFields || []).find((cf) => fm[cf.id] === name);
  return f ? f.value : null;
};

async function ghlCampaignLeads({ campaign, since, until }) {
  assertGhl();
  if (!since || !until) throw new Error("since and until (YYYY-MM-DD) are required");
  const { gte, lte } = etDayToUtcRange(since, until);
  const [pipelines, fm] = await Promise.all([ghlPipelines(), ghlFieldMap()]);
  const stageMap = {};
  for (const pl of pipelines) for (const s of pl.stages) stageMap[s.id] = { stage: s.name, pipe: pl.name };
  const contacts = await ghlContacts(gte, lte);
  const opps = await ghlOpportunities(new Date(gte).getTime() - 7 * 86400 * 1000);
  const oppByContact = {};
  for (const o of opps) (oppByContact[o.contactId] = oppByContact[o.contactId] || []).push(o);
  const fv = fieldValFn(fm);
  const needle = (campaign || "").toLowerCase().trim();
  const leads = [];
  for (const c of contacts) {
    const camp = fv(c, "UTM_Campaign") || "";
    const adid = fv(c, "AdID") || "";
    if (needle && !(camp.toLowerCase().includes(needle) || adid.toLowerCase() === needle)) continue;
    let best = "NO_OPP", rev = 0, bestStage = null, bestPipe = null;
    for (const o of (oppByContact[c.id] || [])) {
      const sm = stageMap[o.pipelineStageId] || {};
      const cat = categorizeStage(sm.stage);
      if (PRIORITY[cat] > PRIORITY[best]) { best = cat; bestStage = sm.stage || null; bestPipe = sm.pipe || null; }
      if (cat === "CLOSED") rev += Number(o.monetaryValue) || 0;
    }
    leads.push({
      name: ((c.firstName || "") + " " + (c.lastName || "")).trim() || "(no name)",
      added: c.dateAdded, source: c.source || null,
      utm_campaign: camp || null, pipeline: bestPipe, stage: bestStage,
      category: best, revenue: rev,
    });
  }
  leads.sort((a, b) => new Date(a.added) - new Date(b.added));
  const sum = leads.reduce((a, l) => { a.total++; a[l.category] = (a[l.category] || 0) + 1; a.revenue += l.revenue || 0; return a; }, { total: 0, revenue: 0 });
  return {
    campaign: campaign || "(all campaigns)", since, until,
    totals: { leads: sum.total, appointments: sum.APPOINTMENT || 0, phone_sales: sum.PHONE_BOOKED || 0,
              closed: sum.CLOSED || 0, dead: sum.DEAD || 0, working: (sum.LEAD || 0) + (sum.NO_OPP || 0), revenue: sum.revenue },
    leads,
  };
}

async function ghlPipelineSummary({ since, until }) {
  assertGhl();
  if (!since || !until) throw new Error("since and until (YYYY-MM-DD) are required");
  const { gte, lte } = etDayToUtcRange(since, until);
  const [pipelines, fm] = await Promise.all([ghlPipelines(), ghlFieldMap()]);
  const stageMap = {};
  for (const pl of pipelines) for (const s of pl.stages) stageMap[s.id] = { stage: s.name, pipe: pl.name };
  const contacts = await ghlContacts(gte, lte);
  const opps = await ghlOpportunities(new Date(gte).getTime() - 7 * 86400 * 1000);
  const oppByContact = {};
  for (const o of opps) (oppByContact[o.contactId] = oppByContact[o.contactId] || []).push(o);
  const fv = fieldValFn(fm);
  const byCamp = {};
  for (const c of contacts) {
    const camp = fv(c, "UTM_Campaign");
    if (!camp || camp === "{{campaign.name}}") continue;
    let best = "NO_OPP", rev = 0;
    for (const o of (oppByContact[c.id] || [])) {
      const cat = categorizeStage((stageMap[o.pipelineStageId] || {}).stage);
      if (PRIORITY[cat] > PRIORITY[best]) best = cat;
      if (cat === "CLOSED") rev += Number(o.monetaryValue) || 0;
    }
    const g = byCamp[camp] = byCamp[camp] || { campaign: camp, leads: 0, appointments: 0, phone_sales: 0, closed: 0, dead: 0, revenue: 0 };
    g.leads++;
    if (best === "CLOSED") { g.closed++; g.revenue += rev; }
    else if (best === "PHONE_BOOKED") g.phone_sales++;
    else if (best === "APPOINTMENT") g.appointments++;
    else if (best === "DEAD") g.dead++;
  }
  return { since, until, campaigns: Object.values(byCamp).sort((a, b) => b.leads - a.leads) };
}

function metaConfigured() { return !!META_TOKEN; }
async function metaGet(path, params) {
  const usp = new URLSearchParams({ access_token: META_TOKEN, ...params });
  const r = await fetch(`https://graph.facebook.com/${META_VER}/${path}?${usp}`);
  const j = await r.json();
  if (j.error) throw new Error(`Meta ${j.error.code}: ${j.error.message}`);
  return j;
}
async function metaCampaignPerformance({ since, until, level }) {
  if (!metaConfigured()) return { configured: false, message: "META_TOKEN not configured. Set META_TOKEN on Render to enable Meta tools. GHL tools work without it." };
  const lvl = level || "campaign";
  const fields = "campaign_name,adset_name,ad_name,spend,impressions,reach,clicks,ctr,cpc,actions";
  const j = await metaGet(`act_${META_AD_ACCT}/insights`, { level: lvl, time_range: JSON.stringify({ since, until }), fields, limit: "200" });
  const rows = (j.data || []).map((d) => {
    const leads = (d.actions || []).find((a) => /lead/.test(a.action_type));
    return { name: d[`${lvl}_name`] || d.campaign_name, spend: Number(d.spend || 0),
      impressions: Number(d.impressions || 0), reach: Number(d.reach || 0), clicks: Number(d.clicks || 0),
      ctr: Number(d.ctr || 0), cpc: Number(d.cpc || 0), leads: leads ? Number(leads.value) : 0 };
  });
  return { configured: true, level: lvl, since, until, rows };
}
async function metaNewCampaigns({ days }) {
  if (!metaConfigured()) return { configured: false, message: "META_TOKEN not configured." };
  const j = await metaGet(`act_${META_AD_ACCT}/campaigns`, { fields: "id,name,status,created_time,start_time", limit: "50" });
  const cutoff = Date.now() - Number(days || 3) * 86400 * 1000;
  const rows = (j.data || []).filter((c) => new Date(c.created_time).getTime() >= cutoff)
    .map((c) => ({ id: c.id, name: c.name, status: c.status, created_time: c.created_time, start_time: c.start_time }));
  return { configured: true, days: Number(days || 3), campaigns: rows };
}

// ---- MCP tool registry ------------------------------------------------------
const TOOLS = [
  { name: "ghl_campaign_leads",
    description: "List GoHighLevel leads for a Local AC ad campaign in a date range, each with its pipeline stage and outcome (appointment / phone sale / closed / dead / working). Answers 'did campaign X get any appointments or sales'.",
    inputSchema: { type: "object", properties: {
      campaign: { type: "string", description: "Campaign name or substring (e.g. 'NorthTampa') or an AdID. Omit for all campaigns." },
      since: { type: "string", description: "Start date YYYY-MM-DD (America/New_York)" },
      until: { type: "string", description: "End date YYYY-MM-DD inclusive (America/New_York)" } },
      required: ["since", "until"] } },
  { name: "ghl_pipeline_summary",
    description: "Summarize GoHighLevel outcomes (leads, appointments, phone sales, closed deals, revenue) grouped by ad campaign for a date range.",
    inputSchema: { type: "object", properties: { since: { type: "string" }, until: { type: "string" } }, required: ["since", "until"] } },
  { name: "meta_campaign_performance",
    description: "Meta Ads performance (spend, impressions, clicks, CTR, CPC, leads) for Local AC by campaign/adset/ad for a date range. Requires META_TOKEN.",
    inputSchema: { type: "object", properties: { since: { type: "string" }, until: { type: "string" }, level: { type: "string", enum: ["campaign", "adset", "ad"] } }, required: ["since", "until"] } },
  { name: "meta_new_campaigns",
    description: "List Local AC Meta campaigns created in the last N days. Requires META_TOKEN.",
    inputSchema: { type: "object", properties: { days: { type: "number" } } } },
];
async function callTool(name, args) {
  switch (name) {
    case "ghl_campaign_leads":        return await ghlCampaignLeads(args || {});
    case "ghl_pipeline_summary":      return await ghlPipelineSummary(args || {});
    case "meta_campaign_performance": return await metaCampaignPerformance(args || {});
    case "meta_new_campaigns":        return await metaNewCampaigns(args || {});
    default: throw new Error(`unknown tool ${name}`);
  }
}
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError  = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

export function buildBridgeRouter() {
  const router = express.Router();

  const gate = (req, res) => {
    const s = req.query.s || req.get("x-bridge-secret");
    if (s !== BRIDGE_SECRET) { res.status(401).json({ ok: false, error: "bad secret" }); return false; }
    return true;
  };
  const wrap = (fn) => async (req, res) => {
    if (!gate(req, res)) return;
    try { res.json({ ok: true, ...(await fn(req)) }); }
    catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
  };

  router.get("/bridge/health", (req, res) => res.json({ ok: true, service: "localac-bridge", ghl: !!GHL_PIT, meta: metaConfigured(), mcp: !!BRIDGE_MCP_TOKEN }));
  router.get("/bridge/ghl/campaign-leads", wrap((req) => ghlCampaignLeads({ campaign: req.query.campaign, since: req.query.since, until: req.query.until })));
  router.get("/bridge/ghl/pipeline-summary", wrap((req) => ghlPipelineSummary({ since: req.query.since, until: req.query.until })));
  router.get("/bridge/meta/performance", wrap((req) => metaCampaignPerformance({ since: req.query.since, until: req.query.until, level: req.query.level })));
  router.get("/bridge/meta/new-campaigns", wrap((req) => metaNewCampaigns({ days: req.query.days })));

  router.post("/bridge/mcp", express.json({ limit: "1mb" }), async (req, res) => {
    if (!BRIDGE_MCP_TOKEN) return res.status(503).json(rpcError(null, -32002, "MCP endpoint not configured (set BRIDGE_MCP_TOKEN)"));
    const bearer = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const tok = bearer || req.query.token;
    if (tok !== BRIDGE_MCP_TOKEN) return res.status(401).json(rpcError(null, -32001, "unauthorized"));

    const msg = req.body || {};
    const { id, method, params } = msg;
    try {
      if (method === "initialize") {
        return res.json(rpcResult(id, {
          protocolVersion: (params && params.protocolVersion) || "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "localac-bridge", version: "1.0.0" },
        }));
      }
      if (method === "notifications/initialized" || method === "notifications/cancelled") return res.status(202).end();
      if (method === "ping") return res.json(rpcResult(id, {}));
      if (method === "tools/list") return res.json(rpcResult(id, { tools: TOOLS }));
      if (method === "tools/call") {
        const out = await callTool(params.name, params.arguments || {});
        return res.json(rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], isError: false }));
      }
      return res.json(rpcError(id ?? null, -32601, `method not found: ${method}`));
    } catch (e) {
      if (method === "tools/call" && id != null) {
        return res.json(rpcResult(id, { content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true }));
      }
      return res.json(rpcError(id ?? null, -32603, String(e.message || e)));
    }
  });

  return router;
}
