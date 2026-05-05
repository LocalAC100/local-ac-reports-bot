// Hubstaff API client.

import axios from "axios";
import { config } from "./config.js";
import { DateTime } from "luxon";

export async function listOrgUsers() {
  const data = await get(`/organizations/${config.hubstaff.orgId}/members`);
  return data?.members ?? data?.users ?? [];
}