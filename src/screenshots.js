// Screenshot manipulation detection.
//
// For each employee in each hour we pull all their Hubstaff screenshots,
// compute an 8x8 average-hash (aHash) for each, and compare consecutive
// hashes. If the visual difference is below a threshold (very similar) but
// Hubstaff is reporting high activity %, we flag "possible system
// manipulation" — that pattern matches a frozen desktop with a
// mouse-jiggler / auto-clicker producing fake input.
import axios from "axios";
import sharp from "sharp";

// 8x8 average hash — small enough to be cheap, robust enough to catch
// frame-identical screenshots while ignoring tiny webcam-style noise.
async function aHash(url) {
  const resp = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 20000,
  });
  const buf = Buffer.from(resp.data);

  const raw = await sharp(buf)
    .resize(8, 8, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer();

  let sum = 0;
  for (let i = 0; i < raw.length; i++) sum += raw[i];
  const avg = sum / raw.length;

  // 64-bit hash as BigInt
  let hash = 0n;
  for (let i = 0; i < raw.length; i++) {
    hash = (hash << 1n) | (raw[i] >= avg ? 1n : 0n);
  }
  return hash;
}

function hammingDistance(a, b) {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}

// Returns { hashes: [{shotId, takenAt, hash, hourBucket}], flags: [...] }
export async function analyzeScreenshots(screenshots, activityByHourPct) {
  // screenshots: array from hubstaff getScreenshots()
  //   each: { id, user_id, time_slot, recorded_at, full_url, ... }
  // activityByHourPct: { "HH:00": pct } — used for cross-flagging
  const hashes = [];
  for (const s of screenshots) {
    try {
      const h = await aHash(s.full_url || s.url);
      hashes.push({
        id: s.id,
        userId: s.user_id,
        recordedAt: s.recorded_at || s.time_slot,
        hash: h,
      });
    } catch (e) {
      // Skip individual hash failures rather than killing the whole report.
    }
  }

  // Sort by time, then sweep for runs of near-identical hashes.
  hashes.sort((a, b) => new Date(a.recordedAt) - new Date(b.recordedAt));

  const flags = [];
  const SIMILAR_THRESHOLD = 4; // bits different out of 64
  const RUN_LENGTH_FOR_FLAG = 3; // need 3 consecutive too-similar shots

  let runStart = 0;
  for (let i = 1; i < hashes.length; i++) {
    const prev = hashes[i - 1];
    const cur = hashes[i];
    const dist = hammingDistance(prev.hash, cur.hash);
    if (dist > SIMILAR_THRESHOLD) {
      runStart = i;
    } else if (i - runStart + 1 >= RUN_LENGTH_FOR_FLAG) {
      // Cross-reference: was activity high in this hour?
      const hour = new Date(cur.recordedAt)
        .toLocaleString("en-US", { hour12: false, timeZone: "America/New_York" })
        .match(/(\d{1,2}):/);
      const hourKey = hour ? `${hour[1].padStart(2, "0")}:00` : null;
      const activityPct = hourKey ? activityByHourPct?.[hourKey] : null;

      if (activityPct == null || activityPct >= 50) {
        flags.push({
          userId: cur.userId,
          windowStart: hashes[runStart].recordedAt,
          windowEnd: cur.recordedAt,
          screenshotCount: i - runStart + 1,
          activityPct,
          reason:
            activityPct != null && activityPct >= 50
              ? `Screenshots are visually near-identical for ${i - runStart + 1} consecutive frames, but activity reads ${activityPct.toFixed(0)}% — pattern consistent with a frozen desktop plus mouse-jiggler / auto-clicker.`
              : `Screenshots are visually near-identical for ${i - runStart + 1} consecutive frames. Worth a manual check.`,
        });
      }
      runStart = i; // reset so we don't re-flag the same run
    }
  }

  return { hashes, flags };
}
