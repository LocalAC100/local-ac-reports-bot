// GoHighLevel API client (v2, Private Integration Token auth).
//
// Auth: every request carries `Authorization: Bearer pit-...` and the
// Version header. Our PIT was created with read-only scopes for contacts,
// conversations, conversations/message, calendars, calendars/events,
// opportunities, users, locations, forms, workflows.
import axios from "axios";
import { config } from "./config.js";

const BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28"; // GHL's required Version header

const http = axios.create({
  baseURL: BASE,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${config.ghl.apiKey}`,
    Version: API_VERSION,
    Accept: "application/json",
  },
});

// Helper: log and rethrow a clean error so callers can decide what to do
function ghlErr(label, e) {
  const status = e.response?.status;
  const data = e.response?.data;
  const snippet = data ? JSON.stringify(data).slice(0, 300) : e.message;
  console.warn(`[ghl] ${label} failed: ${status || ""} ${snippet}`);
}

// ---------- Pipelines / Opportunities ----------

export async function listPipelines() {
  try {
    const r = await http.get("/opportunities/pipelines", {
      params: { locationId: config.ghl.locationId },
    });
    return r.data?.pipelines ?? [];
  } catch (e) {
    ghlErr("listPipelines", e);
    return [];
  }
}

export async function searchOpportunities({ pipelineId, status, limit = 100 }) {
  const params = {
    location_id: config.ghl.locationId,
    limit,
  };
  if (pipelineId) params.pipeline_id = pipelineId;
  if (status) params.status = status;
  try {
    const r = await http.get("/opportunities/search", { params });
    return r.data?.opportunities ?? [];
  } catch (e) {
    ghlErr("searchOpportunities", e);
    return [];
  }
}

// ---------- Contacts (leads) ----------

export async function searchContacts({ from, to, limit = 100 }) {
  // GHL uses "dateAdded" filter in search. ISO strings expected.
  try {
    const r = await http.post("/contacts/search", {
      locationId: config.ghl.locationId,
      pageLimit: limit,
      filters: [
        {
          field: "dateAdded",
          operator: "between",
          value: [from, to],
        },
      ],
    });
    return r.data?.contacts ?? [];
  } catch (e) {
    ghlErr("searchContacts", e);
    return [];
  }
}

export async function getContact(contactId) {
  try {
    const r = await http.get(`/contacts/${contactId}`, {
      params: { locationId: config.ghl.locationId },
    });
    return r.data?.contact;
  } catch (e) {
    ghlErr(`getContact(${contactId})`, e);
    return null;
  }
}

// ---------- Conversations & Calls ----------
// Calls in GHL are stored as messages of type CALL inside conversations.
//
// We removed the previous `lastMessageDirection: "outbound"` filter — it
// excluded any conversation where the customer texted back, which is most
// of them. We also drop hard date filters at the conversation level (they
// behave inconsistently in GHL v2) and instead pull recent conversations,
// then date-filter individual MESSAGES later.

export async function searchConversations({ from, to, limit = 100 } = {}) {
  // We pull the most recent conversations (sorted desc by lastMessageDate),
  // up to `limit`. Caller filters messages by date afterwards.
  try {
    const params = {
      locationId: config.ghl.locationId,
      limit,
      sort: "desc",
      sortBy: "last_message_date",
      status: "all",
    };
    // Best-effort date scoping if both bounds supplied. GHL accepts unix-ms.
    if (from) params.startDate = new Date(from).getTime();
    if (to) params.endDate = new Date(to).getTime();
    const r = await http.get("/conversations/search", { params });
    return r.data?.conversations ?? [];
  } catch (e) {
    ghlErr("searchConversations", e);
    // Fallback: try without the date params (some PITs/locations reject them)
    try {
      const r = await http.get("/conversations/search", {
        params: {
          locationId: config.ghl.locationId,
          limit,
          sort: "desc",
          sortBy: "last_message_date",
          status: "all",
        },
      });
      return r.data?.conversations ?? [];
    } catch (e2) {
      ghlErr("searchConversations(fallback)", e2);
      return [];
    }
  }
}

export async function getConversationMessages(conversationId) {
  try {
    const r = await http.get(`/conversations/${conversationId}/messages`, {
      params: { locationId: config.ghl.locationId, limit: 100 },
    });
    return r.data?.messages?.messages ?? r.data?.messages ?? [];
  } catch (e) {
    ghlErr(`getConversationMessages(${conversationId})`, e);
    return [];
  }
}

// ---------- Calendar / Appointments ----------

export async function listAppointments({ from, to }) {
  try {
    const r = await http.get("/calendars/events/appointments", {
      params: {
        locationId: config.ghl.locationId,
        startTime: new Date(from).getTime(),
        endTime: new Date(to).getTime(),
      },
    });
    return r.data?.events ?? [];
  } catch (e) {
    ghlErr("listAppointments", e);
    return [];
  }
}

// ---------- Users (dispatchers / loc users) ----------

export async function listUsers() {
  try {
    const r = await http.get("/users/", {
      params: { locationId: config.ghl.locationId },
    });
    return r.data?.users ?? [];
  } catch (e) {
    ghlErr("listUsers", e);
    return [];
  }
}

// ---------- Diagnostic probe ----------
// Used by /admin/ghl-debug to figure out why the calls report shows zero.
// Returns raw responses (truncated) so we can see what GHL actually said.
export async function probe() {
  const out = {};
  const safe = async (label, fn) => {
    try {
      const v = await fn();
      out[label] = { ok: true, sample: v };
    } catch (e) {
      out[label] = {
        ok: false,
        status: e.response?.status,
        body: e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : e.message,
      };
    }
  };
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const fromIso = new Date(dayAgo).toISOString();
  const toIso = new Date(now).toISOString();

  await safe("listUsers", async () => {
    const r = await http.get("/users/", { params: { locationId: config.ghl.locationId } });
    return { count: (r.data?.users || []).length, first: (r.data?.users || [])[0] };
  });
  await safe("conversations.search.dated", async () => {
    const r = await http.get("/conversations/search", {
      params: {
        locationId: config.ghl.locationId,
        limit: 5,
        sort: "desc",
        sortBy: "last_message_date",
        startDate: dayAgo,
        endDate: now,
      },
    });
    return { count: (r.data?.conversations || []).length, sample: (r.data?.conversations || [])[0] };
  });
  await safe("conversations.search.bare", async () => {
    const r = await http.get("/conversations/search", {
      params: {
        locationId: config.ghl.locationId,
        limit: 5,
        sort: "desc",
        sortBy: "last_message_date",
      },
    });
    return { count: (r.data?.conversations || []).length, sample: (r.data?.conversations || [])[0] };
  });
  await safe("conversations.search.outboundOnly", async () => {
    const r = await http.get("/conversations/search", {
      params: {
        locationId: config.ghl.locationId,
        limit: 5,
        lastMessageDirection: "outbound",
        sort: "desc",
        sortBy: "last_message_date",
      },
    });
    return { count: (r.data?.conversations || []).length, sample: (r.data?.conversations || [])[0] };
  });
  await safe("contacts.search.dated", async () => {
    const r = await http.post("/contacts/search", {
      locationId: config.ghl.locationId,
      pageLimit: 5,
      filters: [{ field: "dateAdded", operator: "between", value: [fromIso, toIso] }],
    });
    return { count: (r.data?.contacts || []).length, sample: (r.data?.contacts || [])[0] };
  });
  return out;
}
