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

// ---------- Pipelines / Opportunities ----------

export async function listPipelines() {
  const r = await http.get("/opportunities/pipelines", {
    params: { locationId: config.ghl.locationId },
  });
  return r.data?.pipelines ?? [];
}

export async function searchOpportunities({ pipelineId, status, limit = 100 }) {
  const params = {
    location_id: config.ghl.locationId,
    limit,
  };
  if (pipelineId) params.pipeline_id = pipelineId;
  if (status) params.status = status;
  const r = await http.get("/opportunities/search", { params });
  return r.data?.opportunities ?? [];
}

// ---------- Contacts (leads) ----------

export async function searchContacts({ from, to, limit = 100 }) {
  // GHL uses "dateAdded" filter in search. ISO strings expected.
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
}

export async function getContact(contactId) {
  const r = await http.get(`/contacts/${contactId}`, {
    params: { locationId: config.ghl.locationId },
  });
  return r.data?.contact;
}

// ---------- Conversations & Calls ----------
// Calls in GHL are stored as messages of type CALL inside conversations.

export async function searchConversations({ from, to, limit = 100 }) {
  // NOTE: do NOT filter by lastMessageDirection here. The GHL filter only returns
  // conversations whose MOST RECENT message is outbound, which silently drops any
  // conversation where the lead replied last (very common). For both reports and
  // alerts we need the full conversation set in the window.
  //
  // Important: tested empirically May 6 2026 — startDate/endDate parameters here
  // filter on conversation CREATION date, not last_message_date. So passing
  // today's window only returned 2 conversations (the 2 leads CREATED today),
  // missing 69 other conversations that had activity today from older leads.
  // Use listActiveConversations() instead for "what was worked on today".
  // Keeping this single-call signature for callers that just want the bare search.
  const r = await http.get("/conversations/search", {
    params: {
      locationId: config.ghl.locationId,
      limit,
      startDate: new Date(from).getTime(),
      endDate: new Date(to).getTime(),
    },
  });
  return r.data?.conversations ?? [];
}

// Pull every conversation whose LAST MESSAGE falls in [from, to].
// Pages through GHL by descending lastMessageDate, stopping once the batch
// dips below the `from` floor. This is the function dispatcher reports + the
// per-contact alert lookup should use — it surfaces conversations from older
// leads that had activity today, not just brand-new leads.
export async function listActiveConversations({ from, to, maxPages = 10 }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  let cursor = toMs + 1;
  const all = [];
  for (let i = 0; i < maxPages; i++) {
    const r = await http.get("/conversations/search", {
      params: {
        locationId: config.ghl.locationId,
        limit: 100,
        sortBy: "last_message_date",
        sort: "desc",
        lastMessageDate: cursor,
      },
    });
    const batch = r.data?.conversations ?? [];
    if (batch.length === 0) break;
    const inWindow = batch.filter((c) => {
      const t = new Date(c.lastMessageDate || 0).getTime();
      return t >= fromMs && t <= toMs;
    });
    all.push(...inWindow);
    // Stop paginating when this batch goes past our floor
    const oldestInBatch = new Date(
      batch[batch.length - 1].lastMessageDate || 0
    ).getTime();
    if (oldestInBatch < fromMs) break;
    cursor = oldestInBatch;
  }
  return all;
}

// Look up conversations by contactId — the ONLY reliable way to find the
// conversation for an alert lookup. Date-filtered search misses conversations
// that existed before the lead webhook fired.
//
// GHL's /conversations/search supports a contactId filter directly. Returns
// at most a couple of conversations per contact in practice.
export async function getConversationsByContactId(contactId) {
  if (!contactId) return [];
  try {
    const r = await http.get("/conversations/search", {
      params: {
        locationId: config.ghl.locationId,
        contactId,
        limit: 20,
      },
    });
    return r.data?.conversations ?? [];
  } catch (e) {
    console.error("[ghl] getConversationsByContactId failed", e?.message);
    return [];
  }
}

// Notes on a specific contact. Used to detect "Vonage call" notes —
// dispatchers add a note that starts with "Called" any time they call via
// Vonage (since Vonage doesn't expose an API on regular accounts). Treats
// those notes as call records for both alerts and reports.
export async function getContactNotes(contactId) {
  try {
    const r = await http.get(`/contacts/${contactId}/notes`);
    return r.data?.notes ?? [];
  } catch (e) {
    // Some accounts don't have notes scope — fail soft, no notes returned.
    return [];
  }
}

export async function getConversationMessages(conversationId) {
  const r = await http.get(`/conversations/${conversationId}/messages`, {
    params: { locationId: config.ghl.locationId, limit: 100 },
  });
  return r.data?.messages?.messages ?? r.data?.messages ?? [];
}

// ---------- Calendar / Appointments ----------

export async function listAppointments({ from, to }) {
  const r = await http.get("/calendars/events/appointments", {
    params: {
      locationId: config.ghl.locationId,
      startTime: new Date(from).getTime(),
      endTime: new Date(to).getTime(),
    },
  });
  return r.data?.events ?? [];
}

// ---------- Users ----------

export async function listUsers() {
  const r = await http.get("/users/", {
    params: { locationId: config.ghl.locationId },
  });
  return r.data?.users ?? [];
}
