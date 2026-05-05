// Screenshot manipulation detection.
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
