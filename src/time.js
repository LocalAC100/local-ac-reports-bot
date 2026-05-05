// All time math is done in America/New_York (Florida) and is DST-aware
// because we use Luxon's IANA timezone support — the cron jobs always fire
// at local 12:00 PM and 7:30 PM, no matter the time of year.
import { DateTime } from "luxon";
import { config } from "./config.js";

export const TZ = config.timezone;

export function now() {
  return DateTime.now().setZone(TZ);
}
