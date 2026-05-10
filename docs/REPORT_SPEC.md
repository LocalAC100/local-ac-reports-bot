# Local AC Daily Report — Spec & Design Decisions

Last revised: May 9, 2026 (mid-session, with Alex)

This doc captures every rule, definition, layout decision, and architecture
choice the daily-report system relies on. Living document — update it when
the design changes.

---

## 1. Business model brief

Local AC is an HVAC company in Orlando + Tampa, FL. Lead lifecycle:

1. Customer fills a Facebook / Instagram lead-form ad → contact lands in GHL.
2. **Dispatcher** (Frank, Mark, Angel, Ellie) calls them — goal: < 1 minute, never > 3.
3. Dispatcher tries to **live-transfer** to **Sal** (sales). If Sal is unavailable,
   dispatcher books **"Over Phone Booked"** — a phone-callback slot, typically
   8:30–9:00 PM. Sal calls back during that window.
4. Sal either closes a phone sale or — preferred — **upgrades to "Appt. Booked"**
   (a physical visit by a tech). Some leads only ever take a phone sale (impatient,
   too far away).

GHL pipelines: **Orlando**, **Tampa**, **Duct Cleaning**.

Stages we care about (Orlando):
- New Lead In · (3) Days Old Leads · Replied to Reactivation · In Contact ·
  Trying To Schedule · Appt. Booked · Over Phone Booked · Purchased / Closed Deal ·
  Lead Not Ready · Not Interested · Outside Service Area · Over The Phone Quote ·
  Purchased / Closed Lead

---

## 2. Office Employees & Schedules

Source of truth: `src/employees.js`.

| Person | Role | Schedule (ET) | Pay | Break |
|---|---|---|---|---|
| **Chris** | office_manager | 8 AM – 9 PM, 7 days/week | $5/hr | 60 min (2×30) |
| **Frank** | dispatcher_manager | Mon 6 AM – 8 PM, Tue–Sat 7 AM – 8 PM, Sun OFF | $4/hr | 60 min (2×30) |
| **Ellie** | dispatcher | Mon/Tue 2:30 PM – 8 PM, Wed 8 AM – 6 PM, Thu–Sat 2:30 PM – 8 PM, Sun OFF | $4/hr | 30 min (2×15) |
| **Angel** | dispatcher | Mon/Tue 8 AM – 2:30 PM, Wed OFF, Thu–Sat 8 AM – 2:30 PM, Sun 8 AM – 6 PM | $4/hr | 30 min (2×15) |
| **Mark** | dispatcher_training | Mon–Fri 8 AM – 4 PM, Sat/Sun OFF | $3/hr | 30 min (2×15) |
| **Sal** | sales_manager | (no schedule — receives live transfers + phone callbacks) | n/a | n/a |
| **Christopher** | service_manager | (no schedule — back office) | n/a | n/a |

Frank is a dispatcher MANAGER, not a primary caller — `idleThresholdMin: 60`
so he isn't false-flagged when he's coordinating techs.

---

## 3. Definitions (call classification)

REAL_CALL_THRESHOLD = **70 seconds**. Set in `src/db.js`. Don't lower without
explicit instruction.

Bucket rules (from `db.js#classifyCall`):

| Bucket | Rule |
|---|---|
| **Live Transfer** | status="completed" AND duration ≥ 70s AND `participants` has a `transfer:` label |
| **Real Call** | status="completed" AND duration ≥ 70s AND no transfer participant |
| **No Answer** | status="no-answer" OR (status="completed" AND duration < 70s). Voicemail pickups land here. |
| **Failed** | status in {failed, busy} |
| **Ringing** | transient state at query time |

Source-of-truth for bucket totals: local SQLite `calls` table populated by
GHL webhook (real-time) + nightly firehose backfill.

---

## 4. Lead Categories — three tabs for daily report

The daily email + Excel split today's lead activity into three categories.
Names are **NEW**, **RESUB**, **REACT**:

### NEW LEAD ("New Leads")
- Contact's `dateAdded` falls on the report day.
- These are first-time GHL contacts — never been in the system before.

### RESUBMISSION ("Resubmission" — formerly "Repeat Submission")
- Contact's `dateAdded` is BEFORE the report day, BUT
- Their opportunity has activity today (createdAt / lastStatusChangeAt / lastStageChangeAt).
- Excludes auto-aging stage moves to **(3) Days Old Leads**, **Lost**,
  **Outside Service Area**, **Junk**, **Not Interested**, **Lead Not Ready** —
  those are workflow-driven, not a real resubmission signal.
- When a known phone/email re-submits an ad form, GHL dedupes the contact
  (keeps original `dateAdded`) but creates a NEW opportunity. That's the
  resubmission signal.

### REACTIVATED ("Reactivated" — formerly "Reactivated Leads")
- Old contact (dateAdded before today)
- NOT a Resubmission (mutually exclusive with above)
- Had a real call (≥70s) or live transfer today, OR had stage move into a
  booked stage today

### Late-night arrivals ("Arrived Last Night")
- Leads that came in **after 9 PM ET** push to NEXT day's report.
- They appear on the next day's report in a separate "Arrived Last Night"
  block (gray rows) so the morning team can see what came in overnight and
  when they were finally called.
- Today's report DOESN'T count them in its New Leads count — they're not
  this day's responsibility.

---

## 5. Bookings — origin & attribution

**Booking stages:** "Appt. Booked" (Physical) and "Over Phone Booked" (Phone Booking).

**"Phone Booking"** (label used in pills) = the GHL stage **"Over Phone Booked"**.
NOT a closed sale — it's a *callback booking*. Sal calls them back later.
The actual phone sale (or upgrade to physical) happens on Sal's followup call.

### Attribution rule for "Originated Bookings"
Credit the booking to the **stage where the lead started today** (start of day),
not where it ended up. Example for Stephanie Coggle on May 7:
- Started today: contact reset to **New Lead In** by her resubmission.
- Mid-day: Angel booked her into **Over Phone Booked**.
- End of day: sales upgraded to **Appt. Booked**.
- → Credited to **Orlando → New Lead In** as the origin.

Two of three bookings on May 7 came from brand-new ad leads landing in
"New Lead In" (HAGERTY, James Southall). The third (Stephanie) was a
resubmission that also entered via "New Lead In" today. So all 3 originated
in New Lead In.

### Pill labels
- 🟢 **Physical** / **Physical Booking** — final state Appt. Booked
- 🟡 **Phone Booking** — final state Over Phone Booked (a callback for sales)
- (was "Phone Sale" — renamed because it's a booked callback, not a closed sale)

---

## 6. Email layout (locked in as of v9 mockup)

### TL;DR — quick read (top, 4 lines)
1. Hubstaff status (who was on track, who was flagged, day cost)
2. Calls (total, real, LT, NA, failed)
3. Leads (count of new, resub, react, late-night)
4. Bookings (count, breakdown, who originated them, where they came from)

### Section 1 — Hubstaff (Hours & Activity)
Per-employee row: Schedule · Clock In (with "Xm early ✓" / "Xm late ❌") ·
Clock Out (same) · Worked (within shift, capped at scheduled) · Break ·
Activity % · Status badge.

**On-track rules (flags only fire on these):**
- ❌ Late clock-in (after scheduled start)
- ❌ Early clock-out (before scheduled end)
- ❌ Hours short (worked less than scheduled)
- ❌ Break exceeded budget

NOT flagged: early clock-in, late clock-out (Alex doesn't pay for those anyway).

### Day Total (right under Section 1)
**Pay = min(actual_hours_worked_within_shift, scheduled_paid_hours) × rate.**
- scheduled_paid_hours = (shift_end − shift_start) − breakMinutesPerShift
- Time clocked OUTSIDE the shift window doesn't count.

### Section 2 — Call Activity (single compact line)
`Total: 548 (545 out · 3 in) | Real: 8 | Live Transfers: 2 | No Answer: 477 87% | Failed: 60 11% | THRESHOLD = 70s`

### Section 3 — Lead Activity (three columns + combined detail table)
Three side-by-side stat cards: **New Leads | Resubmission | Reactivated**.
Each shows: count, response-time buckets (≤1m / ≤3m / >3m / never),
real calls, live transfers, **Booked Today** with `X Physical + Y Phone Booking`
breakdown, **Real → Book %**.

Combined detail table below with a Cat pill per row (NEW / RESUB / REACT / NIGHT).
Columns: Cat, #, Lead, Source, Came In, First Call, Resp. bucket pill,
Real Call duration, **1st Disp**, **On Shift** (other dispatchers on shift
when lead came in), LT, Final Stage, **Booked Today** (Phone Booking / Physical / —),
**Attempts** (total calls placed today to that contact).

### Section 4 — Dispatcher Performance
Per-dispatcher rollup. Columns: Dispatcher, Total, Real Call, Live Transfer,
No Answer, Failed, Unique Contacts, Avg / Contact (color-coded green if 2–4,
red if <2, yellow if >4), % Real, **Physical Booked**, **Phone Booking**.

### Section 5 — Hour × Dispatcher Matrix
Cells = total calls that hour by that dispatcher. **Bookings shown inline**
as green pill annotations (e.g., "6 +1🟢 +1🟡" = 6 calls + 1 Physical + 1 Phone).
**TOTAL BOOKINGS row** above the TOTAL CALLS row. Right-side **Bookings column**
shows total bookings made that hour.

### Section 6 — Pipelines · Stages · Lead Age
**6a — Pipeline overview cards** (3 wide: Orlando / Tampa / Duct Cleaning).
Each card: total · real · LT · unique · Bookings Today (Physical/Phone breakdown).

**6b — Stage breakdown table.** All pipeline+stage combos. Last column:
**Originated Bookings** = bookings whose START-OF-DAY stage was this one.

**6c — Booking Funnel** (narrative). Groups bookings by their origin stage.
Each booking gets a sentence: "X → became [type] · [dispatcher] · [duration] real call · response [time]".
Special "RESUBMISSION today" badge for resub leads. Resub leads also show their
full historical path (e.g., "New Lead In Jun 22 2025 → Over Phone Booked → Appt. Booked").
Plus zero-rows for context (Reactivation: 0, (3) Days Old: 0).

**6d — Lead Age × Dispatcher heatmap.** Rows: Today / 2-3d / 4-7d / 8+d.
Columns: each dispatcher + Total + Real Calls + Bookings. Cells shaded blue
by relative volume. Tells you at a glance who's working which lead-age bucket.

### Workflow callout (above the takeaway)
Blue box explaining: live transfer is preferred. If Sal unavailable, dispatcher
books Over Phone Booked. Sal calls back later, either phone-sale or upgrades
to Physical. Some leads stay phone-sale (impatient, too far).

---

## 7. Excel companion file (attached to every report email)

Tabs (current state, will update to match Section 6 design):
- Summary
- All Calls (master sheet, every call as a row, color-coded by bucket)
- New Leads
- Repeat Submissions  *(rename to "Resubmission" pending)*
- Reactivated Leads  *(rename to "Reactivated" pending)*
- By Dispatcher
- By Pipeline
- By Pipeline Stage
- By Lead Age
- Hourly
- By Outbound #
- Hour x Dispatcher
- Lead Activity Breakdown
- Notes
- _Diagnostic (build counts, contact map sizes, search errors)

Excel and email always use the same numbers. Excel has every-row drill-downs
the email summarizes.

---

## 8. Alerts — rules

### Lead-not-called (3 min / 10 min)
Trigger: GHL webhook on Contact Created, business hours 8 AM – 8 PM ET.
Two timers per lead.

**Suppression** — alert is silenced if any of:
- 1+ outbound call ≥ 70s (real conversation)
- 1+ live transfer
- 2+ outbound call attempts (any duration)

**Texts do NOT suppress.** A text means they didn't pick up.

Suppression check uses the **local SQLite `calls` table first** (real-time,
fed by webhook). Falls back to GHL conversation API if local table is empty.

### Dispatcher-idle (20 min)
Trigger: cron every 5 min, only during 8 AM – 8 PM ET.
For each dispatcher who is **on shift right now** (per `employees.js`):
- `idle = now − max(last_outbound_call_today, shift_start_today)`
- Alert if idle > 20 min (Frank: 60 min override)
- Mute 30 min per dispatcher after firing (no spam)

Anchored to **TODAY's shift only** — eliminates the "1,211-min idle" false
alerts from comparing to last week's last call.

### Recipients
Currently: admin@local-ac.com (config.recipient).
Will add Chris (office_manager) once everything is verified.
Will eventually go to: Alex + Chris + Sal — same recipient list as the
daily reports.

---

## 9. Code architecture

### Bot service
- Runs on Render at `local-ac-reports-bot.onrender.com`
- Auto-deploys from main branch of `github.com/LocalAC100/local-ac-reports-bot`
- Deploy hook: `https://api.render.com/deploy/srv-d7t4vdd0lvsc73d8571g?key=hc0hI9II8og`
- Cron: 12:00 PM ET morning report, 7:30 PM ET evening report, every 5 min
  idle check 8 AM – 8 PM
- Webhook: `POST /webhooks/ghl?secret=...` for live lead alerts

### Key files
- `src/index.js` — entry, cron schedules, server boot
- `src/server.js` — Express setup, routes
- `src/reports.js` — runMorningReport / runEveningReport orchestrators (1303 lines)
- `src/template.js` — email HTML rendering
- `src/excel-report.js` — Excel generator (all tabs)
- `src/alerts.js` — live lead alerts
- `src/idle.js` — dispatcher-idle alerts
- `src/db.js` — SQLite schema + Calls / Alerts / Reports / Users / Chat helpers
- `src/ghl.js` — GoHighLevel API client (PIT bearer, refresh-token rotation)
- `src/hubstaff.js` — Hubstaff client (refresh-token rotation, disk persistence)
- `src/employees.js` — schedule + pay rate + break budget per person
- `src/firehose-backfill.js` — internal-API backfill + debug endpoints
- `src/email-mockup.html` — current frozen layout reference

### Debug endpoints (secret = `lac-jwt-2026-bootstrap-axabramov`)
All accept `?s=<secret>` for auth bypass:
- `/admin/debug/bucket-counts?date=YYYY-MM-DD` — totals from SQLite
- `/admin/debug/firehose-backfill?date=YYYY-MM-DD` — re-pull from GHL internal API
- `/admin/debug/run-morning-report?date=YYYY-MM-DD` — fire morning email
- `/admin/debug/run-evening-report?date=YYYY-MM-DD` — fire evening email
- `/admin/debug/build-excel?date=YYYY-MM-DD&send=1` — build Excel + email it
- `/admin/debug/send-mockup?to=<email>` — email the static mockup HTML
- `/admin/debug/inspect-leads?date=YYYY-MM-DD` — dump contacts created on date
- `/admin/debug/inspect-opps?date=YYYY-MM-DD` — dump opportunity timestamps

---

## 10. May 7, 2026 — verified ground truth (regression target)

Bot's bucket-counts must match these for any May 7 query:
- Total: **548**, outbound: **545**, inbound: **3**
- Live Transfer: **2** · Real Call: **8** · No Answer: **477** · Failed: **60** · Ringing: **1**
- Outbound by user: Mark **213** / Ellie **171** / Angel **101** / Frank **53** / Chris **7**

Lead categorization:
- **15 New Leads** today + 3 arrived after 9 PM (move to next day)
- **2 Resubmissions**: Stephanie Coggle (fb), Heather Dee (fb)
- **3 Reactivated**: Roberto González (fb, 4d), THOMAS MIANO (ig, 14d), Jessica (fb, 2d)
- **3 Bookings**: HAGERTY,ROBIN (Physical, by Frank), James Southall (Phone Booking, by Frank), Stephanie Coggle (Physical, via Angel→sales)
- All 3 bookings originated in **New Lead In** stage today.

---

## 11. Open work

- **Alerts rebuild** — apply the rules in §8 to `alerts.js` and `idle.js`. In progress.
- **Hubstaff data audit** — fix activity-% interpretation, real clock-in/out
  pulled from API, replace placeholder data in Section 1.
- **Excel content sync** — bring Excel tabs in line with Section 6 design
  (Originated Bookings, Booking Funnel, Lead Age × Dispatcher heatmap).
- **reports.js patch** — attach Excel buffer to morning + evening sendMail calls.
- **Real email layout migration** — rewrite `template.js` to produce the new
  Section 1–6 layout from the mockup.

