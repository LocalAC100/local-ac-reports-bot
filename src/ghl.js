// GoHighLevel API client (v2, Private Integration Token auth).
//
// Auth: every request carries `Authorization: Bearer pit-...` and the
// Version header. Our PIT was created with read-only scopes for contacts,
// conversations, conversations/message, calendars, calendars/events,
// opportunities, users, locations, forms, workflows.
import axios from "axios";
import { config } from "./config.js";

const BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

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
//
// FIXED 2026-05-08: GHL changed the contacts/search filter operator API.
// The valid operators are: eq, not_eq, contains, not_contains, wildcard,
// not_wildcard, match, not_match, exists, not_exists, range, not_range,
// contains_set, contains_not_set, gt, gte, lt, lte, nested, nested_not,
// has_child, has_parent. The old "between" was rejected with 422.
// Use "range" with { gte, lte } shape for date-window queries.
export async function searchContacts({ from, to, limit = 100 }) {
  const r = await http.post("/contacts/search", {
    locationId: config.ghl.locationId,
    pageLimit: limit,
    filters: [
      {
        field: "dateAdded",
        operator: "range",
        value: { gte: from, lte: to },
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
export async function searchConversations({ from, to, limit = 100 }) {
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

export async function listActiveConversations({ from, to, maxPages = 10 }) {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  let cursor = toMs + 1;
  const seen = new Set();
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
    let addedThisPage = 0;
    for (const c of batch) {
      const t = new Date(c.lastMessageDate || 0).getTime();
      if (t < fromMs || t > toMs) continue;
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      all.push(c);
      addedThisPage++;
    }
    const oldestInBatch = new Date(
      batch[batch.length - 1].lastMessageDate || 0
    ).getTime();
    if (oldestInBatch < fromMs) break;
    if (addedThisPage === 0) break;
    const nextCursor = oldestInBatch - 1;
    if (nextCursor >= cursor) break;
    cursor = nextCursor;
  }
  return all;
}

export async function searchContactsByPhone(phone) {
  if (!phone) return [];
  const cleaned = String(phone).replace(/[^\d+]/g, "");
  try {
    const r = await http.post("/contacts/search", {
      locationId: config.ghl.locationId,
      pageLimit: 20,
      filters: [
        {
          field: "phone",
          operator: "contains",
          value: cleaned,
        },
      ],
    });
    return r.data?.contacts ?? [];
  } catch (e) {
    console.error("[ghl] searchContactsByPhone failed", e?.message);
    return [];
  }
}

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

export async function getContactNotes(contactId) {
  try {
    const r = await http.get(`/contacts/${contactId}/notes`);
    return r.data?.notes ?? [];
  } catch (e) {
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
