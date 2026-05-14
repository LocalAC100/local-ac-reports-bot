// Local AC office employees — schedules, roles, pay rates.
//
// schedule format: object keyed by day-of-week (0=Sun ... 6=Sat).
//   Each value is either null (day off) or {start: "HH:MM", end: "HH:MM"} in ET.
//
// hubstaffEmail / ghlEmail: needed for cross-system matching. Fill in once
// known. If the same email is used in both systems, just set hubstaffEmail
// and leave ghlEmail blank — the matcher falls back to hubstaffEmail.
//
// breakMinutesPerShift: total break-minute budget per shift. The bot flags
// when an employee's accumulated break time exceeds this. Specific break
// times are not enforced — only the daily total.

export const EMPLOYEES = [
  {
    name: "Chris",
    fullName: "Christian Quafiricua",
    role: "office_manager", // does NOT count as dispatcher in GHL report
    payRate: 5,
    hubstaffEmail: "christianq@local-ac.com",
    ghlEmail: "Christianq@local-ac.com",
    hubstaffUserId: 2768557,
    schedule: {
      0: { start: "09:00", end: "18:00" }, // Sun (9 AM - 6 PM)
      1: { start: "08:00", end: "21:00" }, // Mon
      2: { start: "08:00", end: "21:00" },
      3: { start: "08:00", end: "21:00" },
      4: { start: "08:00", end: "21:00" },
      5: { start: "08:00", end: "21:00" },
      6: { start: "08:00", end: "21:00" }, // Sat
    },
    breakMinutesPerShift: 60, // 2 × 30 min
    // Office manager — supervises dispatchers, handles billing, fields walk-ins.
    // His non-call stretches are normal for the role, so the idle-call alert
    // skips him entirely. (Already excluded by isDispatcher() returning false
    // for "office_manager", but this flag makes the intent explicit.)
    idleAlertsExcluded: true,
  },
  {
    name: "Frank",
    fullName: "Frank Maglanoc",
    role: "dispatcher_manager",
    payRate: 4,
    hubstaffEmail: "frankmi@local-ac.com",
    ghlEmail: "frankmi@local-ac.com",
    hubstaffUserId: 3009622,
    schedule: {
      0: null, // Sun OFF
      1: { start: "06:00", end: "20:00" }, // Mon
      2: { start: "07:00", end: "20:00" }, // Tue
      3: { start: "07:00", end: "20:00" },
      4: { start: "07:00", end: "20:00" },
      5: { start: "07:00", end: "20:00" },
      6: { start: "07:00", end: "20:00" }, // Sat
    },
    breakMinutesPerShift: 60, // 2 × 30 min
    // Frank is a dispatcher MANAGER, not a primary caller. He supervises the
    // team, orders equipment, talks with techs, assigns jobs, chases customer
    // financing/completion docs. Frequent 20+ min stretches without GHL
    // activity are normal for his role. Per Alex's v20 spec: exclude him
    // from idle-call alerts entirely (more responsibility than the dialing
    // dispatchers). idleThresholdMin kept for historical / non-alert tools.
    idleThresholdMin: 60,
    idleAlertsExcluded: true,
  },
  {
    name: "Ellie",
    fullName: "Ellie Guerra",
    role: "dispatcher",
    payRate: 4,
    hubstaffEmail: "ellie.guerra04@gmail.com",
    ghlEmail: "ellie.guerra04@gmail.com",
    hubstaffUserId: 3511580,
    schedule: {
      0: null, // Sun OFF
      1: { start: "14:30", end: "20:00" }, // Mon
      2: { start: "14:30", end: "20:00" }, // Tue
      3: { start: "08:00", end: "18:00" }, // Wed
      4: { start: "14:30", end: "20:00" }, // Thu
      5: { start: "14:30", end: "20:00" }, // Fri
      6: { start: "14:30", end: "20:00" }, // Sat
    },
    breakMinutesPerShift: 30, // 2 × 15 min
  },
  {
    name: "Angel",
    fullName: "Angel Sejera",
    role: "dispatcher",
    payRate: 4,
    hubstaffEmail: "angel.solano.sejera@gmail.com",
    ghlEmail: "angel.solano.sejera@gmail.com",
    hubstaffUserId: 3930293,
    schedule: {
      0: { start: "08:00", end: "18:00" }, // Sun
      1: { start: "08:00", end: "14:30" }, // Mon
      2: { start: "08:00", end: "14:30" }, // Tue
      3: null, // Wed OFF
      4: { start: "08:00", end: "14:30" }, // Thu
      5: { start: "08:00", end: "14:30" }, // Fri
      6: { start: "08:00", end: "14:30" }, // Sat
    },
    breakMinutesPerShift: 30, // 2 × 15 min
  },
  {
    name: "Mark",
    fullName: "Mark Jay Vergara",
    role: "dispatcher_training",
    payRate: 3,
    // Mark joined GHL and is making calls. Hubstaff still TBD — fill in
    // his hubstaffEmail once he's added there. GHL email confirmed via the
    // location's user roster (May 6 2026).
    hubstaffEmail: "",
    ghlEmail: "markjayvergara@gmail.com",
    schedule: {
      0: null, // Sun OFF
      1: { start: "08:00", end: "16:00" }, // Mon
      2: { start: "08:00", end: "16:00" },
      3: { start: "08:00", end: "16:00" },
      4: { start: "08:00", end: "16:00" },
      5: { start: "08:00", end: "16:00" }, // Fri
      6: null, // Sat OFF
    },
    breakMinutesPerShift: 30, // 2 × 15 min
  },
  {
    // Sales manager — receives live transfers + handles phone-sale appointments.
    // Not a dispatcher: excluded from dispatcher call/booking metrics, but kept
    // here so we can attribute live transfers TO him correctly.
    name: "Sal",
    fullName: "Salvatore Albano",
    role: "sales_manager",
    payRate: null,
    hubstaffEmail: "",
    ghlEmail: "salbano45@gmail.com",
    schedule: null,
    breakMinutesPerShift: 0,
  },
  {
    // Service manager — back-office, not measured on dispatcher metrics.
    name: "Christopher",
    fullName: "Christopher DiPrimo",
    role: "service_manager",
    payRate: null,
    hubstaffEmail: "",
    ghlEmail: "Cdprimo@local-ac.com",
    schedule: null,
    breakMinutesPerShift: 0,
  },
  {
    // Owner. Not a regular employee — no schedule, no payroll. Added so the
    // GHL call dispatcher "Alexander Abramov" resolves to a real first name
    // in Hour x Dispatcher / Lead Activity instead of "(unknown)".
    name: "Alex",
    fullName: "Alexander Abramov",
    role: "owner",
    payRate: null,
    hubstaffEmail: "",
    ghlEmail: "axabramov2@gmail.com",
    schedule: null,
    breakMinutesPerShift: 0,
  },
  {
    // Owner. Not a regular employee — no schedule, no payroll. Added so the
    // GHL call dispatcher "Alexander Abramov" resolves to a real first name
    // in Hour x Dispatcher / Lead Activity instead of "(unknown)".
    name: "Alex",
    fullName: "Alexander Abramov",
    role: "owner",
    payRate: null,
    hubstaffEmail: "",
    ghlEmail: "axabramov2@gmail.com",
    schedule: null,
    breakMinutesPerShift: 0,
  },
];

export function isDispatcher(emp) {
  return emp.role === "dispatcher" ||
    emp.role === "dispatcher_manager" ||
    emp.role === "dispatcher_training";
}

export function expectedShiftFor(emp, dateLuxon) {
  // dateLuxon is a Luxon DateTime in America/New_York
  if (!emp.schedule) return null; // Sal / Christopher have no schedule (back-office)
  const dow = dateLuxon.weekday % 7; // luxon: 1=Mon..7=Sun → convert to 0=Sun..6=Sat
  const key = dow; // already 0=Sun .. 6=Sat after % 7
  return emp.schedule[key];
}
