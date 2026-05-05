// Live alert: kzwhen a new lead comes in via the GHL webhook, start a 3-minute
// timer. If the dispatcher hasn't called by then, fire an email alert.
import { config } from "./config.js";
import * as ghl from "./ghl.js";
import { sendMail } from "./mailer.js";
import { renderLiveAlert } from "./template.js";
