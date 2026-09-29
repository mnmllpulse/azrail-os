import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const stagingPath = resolve(root, "wrangler.staging.toml");
const examplePath = resolve(root, "wrangler.staging.toml.example");
const prodPath = resolve(root, "wrangler.toml");
const lockPath = resolve(root, "package-lock.json");

const fail = (message) => {
  console.error("STAGING CHECK FAILED:", message);
  process.exit(1);
};

let staging;
try {
  staging = readFileSync(stagingPath, "utf8");
} catch {
  console.error("Missing wrangler.staging.toml. Copy wrangler.staging.toml.example and fill staging-only resource IDs.");
  process.exit(2);
}

const prod = readFileSync(prodPath, "utf8");
const example = readFileSync(examplePath, "utf8");
const lock = JSON.parse(readFileSync(lockPath, "utf8"));
const uncommented = staging.replace(/^\s*#.*$/gm, "");
const match = (text, pattern) => text.match(pattern)?.[1] ?? "";

if (/REPLACE_STAGING_[A-Z0-9_]+/.test(staging)) fail("staging placeholders are still present.");
if (!/name\s*=\s*"azrail-os-staging"/.test(staging)) fail("worker name must be azrail-os-staging.");
if (!/workers_dev\s*=\s*true/.test(staging)) fail("baseline staging must deploy to workers.dev.");
if (!/database_name\s*=\s*"azrail-db-staging"/.test(staging)) fail("staging D1 name is missing.");
if (!/bucket_name\s*=\s*"azrail-artifacts-staging"/.test(staging)) fail("staging R2 bucket is missing.");
if (!/AZRAIL_FORCE_FREE\s*=\s*"true"/.test(staging)) fail("staging must be force-free by default.");
if (!/AZRAIL_WORKERS_PLAN\s*=\s*"free"/.test(staging)) fail("baseline staging must not claim paid Workers features.");
if (!/AZRAIL_METERING\s*=\s*"observe"/.test(staging)) fail("staging metering must start in observe mode.");
if (/AI_GATEWAY_ID\s*=/.test(uncommented)) fail("AI Gateway must be opt-in in staging.");
if (/\[\[containers\]\]/.test(uncommented)) fail("containers are disabled in baseline staging.");
if (/\[triggers\]/.test(uncommented)) fail("cron triggers are disabled in baseline staging.");
if (/CORS_ORIGIN\s*=\s*"\*"/.test(staging)) fail("wildcard CORS is not allowed in staging.");
if (/AZRAIL_TOKEN\s*=/.test(uncommented)) fail("AZRAIL_TOKEN must be a Wrangler secret, not a config var.");
if (/GITHUB_TOKEN\s*=/.test(uncommented)) fail("GITHUB_TOKEN must never be committed to staging config.");

const prodD1 = match(prod, /database_id\s*=\s*"([^"]+)"/);
const prodKv = match(prod, /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/);
const prodBucket = match(prod, /bucket_name\s*=\s*"([^"]+)"/);
const stageD1 = match(staging, /database_id\s*=\s*"([^"]+)"/);
const stageKv = match(staging, /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([^"]+)"/);
const stageBucket = match(staging, /bucket_name\s*=\s*"([^"]+)"/);

if (!stageD1 || !stageKv || !stageBucket) fail("staging D1/KV/R2 bindings are incomplete.");
if (prodD1 && stageD1 === prodD1) fail("staging D1 reuses the production database ID.");
if (prodKv && stageKv === prodKv) fail("staging KV reuses the production namespace ID.");
if (prodBucket && stageBucket === prodBucket) fail("staging R2 reuses the production bucket.");
if (staging === prod || staging === example) fail("staging config was not customized.");

const wrangler = lock.packages?.["node_modules/wrangler"]?.version ?? "0.0.0";
const major = Number(wrangler.split(".")[0] ?? 0);
if (major < 4) fail("Wrangler 4+ is required by this staging workflow.");

console.log("Staging config is isolated from production resources.");
console.log("Wrangler:", wrangler);
console.log("Worker: azrail-os-staging");
console.log("D1: azrail-db-staging");
console.log("R2: azrail-artifacts-staging");
