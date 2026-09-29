import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const stagingPath = resolve(root, "wrangler.staging.toml");
const examplePath = resolve(root, "wrangler.staging.toml.example");
const prodPath = resolve(root, "wrangler.toml");
const lockPath = resolve(root, "package-lock.json");

let staging;
try {
  staging = readFileSync(stagingPath, "utf8");
} catch {
  console.error("Missing wrangler.staging.toml. Copy wrangler.staging.toml.example and fill staging-only resource IDs.");
  process.exit(2);
}
const prod = readFileSync(prodPath, "utf8");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const example = readFileSync(examplePath, "utf8");

const fail = (message) => {
  console.error("STAGING CHECK FAILED:", message);
  process.exit(1);
};
const match = (text, pattern) => text.match(pattern)?.[1] ?? "";

if (/REPLACE_STAGING_[A-Z0-9_]+/.test(staging)) fail("staging placeholders are still present.");
if (!/name\s*=\s*"azrail-os-staging"/.test(staging)) fail("worker name must be azrail-os-staging.");
if (!/database_name\s*=\s*"azrail-db-staging"/.test(staging)) fail("staging D1 name is missing.");
if (!/bucket_name\s*=\s*"azrail-artifacts-staging"/.test(staging)) fail("staging R2 bucket is missing.");
if (!/AZRAIL_FORCE_FREE\s*=\s*"true"/.test(staging)) fail("staging must be force-free by default.");
if (!/AZRAIL_METERING\s*=\s*"observe"/.test(staging)) fail("staging metering must start in observe mode.");
if (/AI_GATEWAY_ID\s*=/.test(staging.replace(/^\s*#.*$/gm, ""))) fail("AI Gateway must be opt-in in staging.");
if (/\[\[containers\]\]/.test(staging)) fail("containers are intentionally disabled in baseline staging.");
if (/\[triggers\]/.test(staging)) fail("cron triggers are intentionally disabled in baseline staging.");
if (/CORS_ORIGIN\s*=\s*"\*"/.test(staging)) fail("wildcard CORS is not allowed in staging.");

const prodD1 = match(prod, /database_id\s*=\s*"([^"]+)"/);
const prodKv = match(prod, /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/);
const prodBucket = match(prod, /bucket_name\s*=\s*"([^"]+)"/);
const stageD1 = match(staging, /database_id\s*=\s*"([^"]+)"/);
const stageKv = match(staging, /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/);
const stageBucket = match(staging, /bucket_name\s*=\s*"([^"]+)"/);

if (prodD1 && stageD1 === prodD1) fail("staging D1 reuses the production database ID.");
if (prodKv && stageKv === prodKv) fail("staging KV reuses the production namespace ID.");
if (prodBucket && stageBucket === prodBucket) fail("staging R2 reuses the production bucket.");
if (staging === prod || staging === example) fail("staging config was not customized.");

const wrangler = lock.packages?.["node_modules/wrangler"]?.version ?? "0.0.0";
const [major, minor] = wrangler.split(".").map(Number);
if (major < 4 || (major === 4 && minor < 45)) fail("Wrangler 4.45+ is required by the staging workflow.");

console.log("Staging config is isolated from production resources.");
console.log("Wrangler:", wrangler);
console.log("Worker: azrail-os-staging");
console.log("D1: azrail-db-staging");
console.log("R2: azrail-artifacts-staging");
