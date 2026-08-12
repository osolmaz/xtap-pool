import { resolve } from "node:path";

import { initializeRawStorage } from "./storage-initialize.js";

const token = process.env["HF_TOKEN"];
const rawBucket = process.env["RAW_BUCKET"];
const workDir = process.env["DATA_DIR"];
const members = process.env["ALLOWED_USERS"]?.split(",").filter(Boolean) ?? [];
const admins = process.env["POOL_ADMINS"]?.split(",").filter(Boolean) ?? members.slice(0, 1);
if (
  token === undefined ||
  rawBucket === undefined ||
  workDir === undefined ||
  members.length === 0
) {
  throw new Error("HF_TOKEN, RAW_BUCKET, DATA_DIR, and ALLOWED_USERS are required");
}
const result = await initializeRawStorage({
  rawBucket,
  token,
  members,
  admins,
  workDir: resolve(workDir, "raw-cache"),
});
console.log(JSON.stringify({ ok: true, ...result }));
