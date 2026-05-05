// All time math is done in America/New_York (Florida) and is DST-aware
// because we use Luxon's IANA timezone support — the cron jobs always fire
// at local 12:00 PM and 7:30 PM, no matter the time of year.
import { DateTime } from "luxon";
import { config } from "./config.js";

export const TZ = config.timezone;

export function now() {
  return DateTime.now().setZone(TZ);
}

export function startOfTodayET() {
  return now().startOf("day");
}

// Morning report covers midnight ET → noon ET (today).
export function morningWindow(when = now()) {
  const day = when.startOf("day");
  return { from: day, to: day.set({ hour: 12, minute: 0, second: 0 }) };
}

// Evening report covers midnight ET → 7:30 PM ET (today).
export function eveningWindow(when = now()) {
  const day = when.startOf("day");
  return {
    from: day,
    to: day.set({ hour: 19, minute: 30, second: 0 }),
  };
}

// 24-hour rolling window ending at the given time. Used for "leads in last 24h".
export function rolling24h(when = now()) {
  return { from: when.minus({ hours: 24 }), to: when };
}

export function fmtTime(dt) {
  return dt.setZone(TZ).toFormat("h:mm a");
}

export function fmtDate(dt) {
  return dt.setZone(TZ).toFormat("EEE, LLL d, yyyy");
}

export function fmtDateTime(dt) {
  return dt.setZone(TZ).toFormat("EEE, LLL d, h:mm a");
}

// Build a Luxon DateTime for today at HH:MM ET (used to compute scheduled
// shift starts/ends from employees.js).
export function todayAtET(hhmm, when = now()) {
  const [h, m] = hhmm.split(":").map(Number);
  return when.startOf("day").set({ hour: h, minute: m });
}

// Hour bucket key for hourly breakdowns (e.g. "09:00", "10:00")
export function hourBucket(dt) {
  return dt.setZone(TZ).toFormat("HH:00");
}

// Format minutes as "Xh Ym" or "Ym" for short durations.
export function fmtDuration(minutes) {
  if (minutes < 1) return "<1m";
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
