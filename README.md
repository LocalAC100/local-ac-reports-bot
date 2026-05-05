# Local AC Reports Bot

Automated daily reporting for Local AC. Pulls data from Hubstaff and GoHighLevel, builds two HTML email reports per day, and sends a live email alert when a new GHL lead goes more than 3 minutes without a callback.

## What gets sent

**12:00 PM ET — Morning Snapshot** (covers midnight → noon)

**7:30 PM ET — Full Day Summary** (covers midnight → 7:30 PM, plus total hours per employee)

Both emails contain two sections:

1. **Hubstaff** — clock-in/out discrepancies, average activity %, hourly activity breakdown, low-activity flags, low-activity-AND-low-calls double flags, and screenshot manipulation watch (perceptual-hash analysis of consecutive screenshots).
2. **GoHighLevel** — per-dispatcher call counts (with <25 s vs ≥25 s split), bookings, appointment-booked / over-phone-sale events, and new-lead response-time check (3-minute threshold).

A separate **live alert** is fired in real time the moment a new GHL lead is created and not contacted within 3 minutes.

## Architecture

Single Node.js process running on a Render Background Worker / Web Service:

```
┌─────────────────────────────────────────────────┐
│   Render web service (always on, Starter plan)  │
│                                                 │
│   ┌─────────────┐    ┌──────────────────────┐  │
│   │ Express     │    │ node-cron            │  │
│   │ POST /webhooks/ghl │    │ 0 12 * * *  →  morning │  │
│   │ GET  /healthz       │    │ 30 19 * * * →  evening │  │
│   └──────┬──────┘    └────────┬─────────────┘  │
│          │                    │                 │
│          └────────┬───────────┘                 │
│                   ▼                             │
│         reports.js / alerts.js                  │
│                   │                             │
│         ┌─────────┴─────────┐                   │
│         ▼                   ▼                   │
│   hubstaff.js           ghl.js                  │
│   (PAT refresh +        (PIT bearer)            │
│    activity API)                                │
│         │                   │                   │
│         └─────────┬─────────┘                   │
│                   ▼                             │
│             mailer.js (SMTP) → reports         │
└─────────────────────────────────────────────────┘
```

## Local setup

```bash
git clone <this repo>
cd local-ac-reports-bot
cp .env.example .env
# fill in credentials in .env
npm install
npm run test:creds   # smoke test all integrations + send a test email
npm run test:morning # run the morning report on demand
```

## Deploying to Render (step by step)

1. Push this repo to GitHub.
2. Sign in to render.com (you have to create the account yourself — Anthropic doesn't allow me to create accounts on your behalf). Free signup.
3. **New → Blueprint** in the Render dashboard, point it at the repo. Render will auto-detect `render.yaml` and create the service.
4. After the service is created, open its **Environment** tab and paste each value from your credentials note:
   - `HUBSTAFF_REFRESH_TOKEN`
   - `HUBSTAFF_ORG_ID`
   - `GHL_LOCATION_API_KEY`
   - `GHL_LOCATION_ID`
   - `GHL_WEBHOOK_SECRET` (any random string — also paste it into GHL's webhook config)
   - `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD`
   - `SMTP_FROM_NAME` / `SMTP_FROM_ADDRESS`
   - `REPORT_RECIPIENT`
5. Click **Manual Deploy → Deploy latest commit**. First build takes ~3 minutes.
6. Once it's running, copy the public URL Render gave you (e.g. `https://local-ac-reports-bot.onrender.com`). Open `/healthz` in a browser — should return `{"ok":true}`.
7. **Wire up the GHL webhook** so live alerts fire. Inside Local AC sub-account → Automation → Workflows → New Workflow:
   - Trigger: **Contact Created**
   - Action: **Webhook**
     - URL: `https://<your-render-url>/webhooks/ghl?secret=<your-GHL_WEBHOOK_SECRET>`
     - Method: POST
     - Map fields: `contact_id`, `first_name`, `last_name`, `phone`, `date_added`
   - Save and turn the workflow on.
8. **(Optional) Verify Resend domain** if using Resend: add the 4 DNS records Resend gives you to the `local-ac.com` registrar. Without verification, emails send from a Resend default domain and may land in spam.

## Email-provider configuration

Three options, all use the same `nodemailer` SMTP path — only the four `SMTP_*` env vars change.

| Provider | SMTP_HOST | SMTP_PORT | SMTP_USER | SMTP_PASSWORD |
|----------|-----------|-----------|-----------|----------------|
| Gmail / Workspace App Password | `smtp.gmail.com` | 587 | full email | 16-char App Password |
| Resend | `smtp.resend.com` | 587 | `resend` | Resend API key (`re_...`) |
| SendGrid | `smtp.sendgrid.net` | 587 | `apikey` | SendGrid API key |

## Notes / gotchas

- **Hubstaff refresh tokens rotate every 30 days.** If the bot is idle for >30 days, the env var must be regenerated at developer.hubstaff.com → Personal Access Tokens.
- **Render Starter plan** ($7/mo) is required — free tier spins down and would miss the cron schedules and webhooks.
- **Time zone** is `America/New_York` and is DST-aware. Reports always fire at local 12:00 PM and 7:30 PM regardless of DST.
- **Screenshot manipulation detection** uses 8×8 average-hashing. It catches frozen desktops and mouse-jiggler patterns. Not a polygraph — patterns can have legitimate causes (full-screen video, idle-but-screen-on, etc.). Treat flags as worth-investigating, not as proof.
