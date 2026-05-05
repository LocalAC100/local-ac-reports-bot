// Claude (Anthropic) integration for the Ask Claude chat tab.
//
// We give Claude tools that can query Jobber, Hubstaff, and GHL on demand.
// User asks a natural-language question → Claude decides which tools to call
// → Claude formulates an answer using the tool results.
import Anthropic from "@anthropic-ai/sdk";
import * as jobber from "./jobber.js";
import * as hubstaff from "./hubstaff.js";
import * as ghl from "./ghl.js";

const MODEL = "claude-sonnet-4-5-20250929";

let client = null;
function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not set in env vars.");
  }
  client = new Anthropic({ apiKey });
  return client;
}

export function isConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

// ---------- Tool definitions exposed to Claude ----------
const TOOLS = [
  {
    name: "list_recent_jobs",
    description: "List recent jobs from Jobber. Returns title, client, status, scheduled date, total. Use this for questions like 'show me recent jobs' or 'what jobs are scheduled this week'.",
    input_schema: {
      type: "object",
      properties: {
        first: { type: "integer", description: "How many jobs to fetch (1-50)", default: 20 },
        status: { type: "string", description: "Optional filter: 'active', 'invoiced', 'completed', 'archived'" },
      },
    },
  },
  {
    name: "list_recent_clients",
    description: "List recently-added clients in Jobber. Use for questions about new customers.",
    input_schema: {
      type: "object",
      properties: { first: { type: "integer", default: 10 } },
    },
  },
  {
    name: "list_invoices",
    description: "List recent invoices from Jobber, including amount outstanding. Use for billing/AR questions.",
    input_schema: {
      type: "object",
      properties: {
        first: { type: "integer", default: 20 },
        status: { type: "string", description: "Optional: 'draft', 'awaiting_payment', 'paid', 'past_due'" },
      },
    },
  },
  {
    name: "today_scheduled_items",
    description: "Get all visits and assessments scheduled in Jobber for today.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_hubstaff_users",
    description: "List all Hubstaff team members (employees being tracked).",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_ghl_pipelines",
    description: "List GoHighLevel pipelines and their stages. Use to understand sales pipeline structure.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_ghl_users",
    description: "List GoHighLevel users (dispatchers, sales reps).",
    input_schema: { type: "object", properties: {} },
  },
];

// ---------- Tool dispatcher ----------
async function runTool(name, input) {
  try {
    switch (name) {
      case "list_recent_jobs":
        return await jobber.listJobs({ first: input.first || 20, status: input.status });
      case "list_recent_clients":
        return await jobber.listRecentClients(input.first || 10);
      case "list_invoices":
        return await jobber.listInvoices({ first: input.first || 20, status: input.status });
      case "today_scheduled_items":
        return await jobber.todayScheduledItems();
      case "list_hubstaff_users":
        return await hubstaff.listOrgUsers();
      case "list_ghl_pipelines":
        return await ghl.listPipelines();
      case "list_ghl_users":
        return await ghl.listUsers();
      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (e) {
    return { error: e.message || String(e) };
  }
}

const SYSTEM_PROMPT = `You are the Local AC Control Room assistant — a friendly, concise operations assistant for an HVAC company in Florida.

You have read-only access to:
- **Jobber** (jobs, clients, invoices, schedule)
- **Hubstaff** (employee time tracking, activity, screenshots)
- **GoHighLevel** (leads, calls, dispatcher activity, pipelines)

When the user asks something, decide which tools to call to answer accurately. If a question is ambiguous, ask a brief clarifying question rather than guessing. Format answers with clear structure: short paragraphs, bullet points for lists, simple tables for comparisons. Use plain English — the user is a business owner, not a developer.

Keep replies focused. Don't over-explain. Don't apologize. Don't recap what the user just said.`;

// ---------- Main chat function ----------
export async function ask({ question, history = [] }) {
  const c = getClient();
  // Convert our chat history (role + content strings) into Anthropic format
  const messages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: question },
  ];

  // Iterative tool-use loop
  let response = await c.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  });

  // Keep looping while Claude wants to use tools
  let safetyLimit = 6; // max tool-use rounds per question
  while (response.stop_reason === "tool_use" && safetyLimit-- > 0) {
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const toolResults = await Promise.all(
      toolUses.map(async (tu) => ({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(await runTool(tu.name, tu.input)),
      }))
    );
    messages.push({ role: "assistant", content: response.content });
    messages.push({ role: "user", content: toolResults });
    response = await c.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
  }

  // Extract final text answer
  const textBlocks = response.content.filter((b) => b.type === "text");
  return textBlocks.map((b) => b.text).join("\n").trim() || "(Claude returned no text.)";
}
