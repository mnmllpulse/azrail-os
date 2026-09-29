import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stagingPath = resolve(root, "wrangler.staging.toml");
const productionPath = resolve(root, "wrangler.toml");
const staging = readFileSync(stagingPath, "utf8");
const production = readFileSync(productionPath, "utf8");

const placeholders = [...staging.matchAll(/REPLACE_[A-Z0-9_]+/g)].map(m => m[0]);
if (placeholders.length) {
  throw new Error("Staging config is not ready: " + [...new Set(placeholders)].join(", "));
}

function capture(text, re, label) {
  const m = re.exec(text);
  if (!m) throw new Error("Missing " + label + " in Wrangler config.");
  return m[1];
}

const prodD1 = capture(production, /database_id\s*=\s*"([^"]+)"/, "production D1 id");
const stageD1 = capture(staging, /database_id\s*=\s*"([^"]+)"/, "staging D1 id");
const prodKv = capture(production, /\[\[kv_namespaces\]\][\s\S]*?\nid\s*=\s*"([^"]+)"/, "production KV id");
const stageKv = capture(staging, /\[\[kv_namespaces\]\][\s\S]*?\nid\s*=\s*"([^"]+)"/, "staging KV id");
const prodR2 = capture(production, /bucket_name\s*=\s*"([^"]+)"/, "production R2 bucket");
const stageR2 = capture(staging, /bucket_name\s*=\s*"([^"]+)"/, "staging R2 bucket");

if (prodD1 === stageD1) throw new Error("Staging D1 must not equal production D1.");
if (prodKv === stageKv) throw new Error("Staging KV must not equal production KV.");
if (prodR2 === stageR2) throw new Error("Staging R2 must not equal production R2.");
if (!/AZRAIL_FORCE_FREE\s*=\s*"true"/.test(staging)) throw new Error("Staging must force free model routing.");
if (/\[\[containers\]\]/.test(staging) || /AZRAIL_SANDBOX/.test(staging)) {
  throw new Error("Staging config must not include production Sandbox/container bindings.");
}

console.log("Staging config isolation verified.");
