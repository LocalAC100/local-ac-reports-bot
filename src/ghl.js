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
      { field: "dateAdded", operator: "gte", value: from },
      { field: "dateAdded", operator: "lte", value: to },
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
  const r = await http.get("/conversations/search", {
    params: {
      locationId: config.ghl.locationId,
      limit,
      // Conversation search supports dates via lastMessageDate filter
      startDate: new Date(from).getTime(),
      endDate: new Date(to).getTime(),
    },
  });
  return r.data?.conversations ?? [];
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
