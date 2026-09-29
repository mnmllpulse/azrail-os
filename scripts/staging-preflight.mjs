import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const file = resolve(root, "wrangler.staging.toml");
if (!existsSync(file)) {
  throw new Error("wrangler.staging.toml отсутствует. Скопируйте wrangler.staging.example.toml и заполните отдельные staging IDs.");
}
const text = readFileSync(file, "utf8");

const failures = [];
if (/REPLACE_WITH_STAGING_/u.test(text)) failures.push("остались placeholder IDs");
if (/^name\s*=\s*"azrail-os"\s*$/mu.test(text)) failures.push("Worker name совпадает с production");
if (text.includes('database_id = "c76e7d92-648c-45bc-b0df-f26b00d0ff88"')) failures.push("используется production D1");
if (text.includes('id = "dab3b792264f4d9cbec5d637d4f8d71e"')) failures.push("используется production KV");
if (/bucket_name\s*=\s*"azrail-artifacts"\s*$/mu.test(text)) failures.push("используется production R2 bucket");
if (!/^name\s*=\s*"[^"]*staging[^"]*"\s*$/mu.test(text)) failures.push("Worker name не содержит staging");
if (!/database_name\s*=\s*"[^"]*staging[^"]*"/u.test(text)) failures.push("D1 name не содержит staging");
if (!/bucket_name\s*=\s*"[^"]*staging[^"]*"/u.test(text)) failures.push("R2 bucket name не содержит staging");
if (!/AZRAIL_FORCE_FREE\s*=\s*"true"/u.test(text)) failures.push("staging должен начинаться в force-free режиме");

if (failures.length) {
  throw new Error("Staging preflight отказан:\n- " + failures.join("\n- "));
}
console.log("PASS: staging config отделён от production bindings и начинается в force-free режиме.");
