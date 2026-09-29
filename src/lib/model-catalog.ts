import type { Env } from "../types";
import { FREE_MODEL_SLUGS } from "./model-policy";
import { findModel } from "./model-registry";

/** Metadata only. Catalog presence never authorizes a paid inference. */
export async function readLiveCatalog(env: Env) {
  const models: Array<{slug:string;task:string;hosted:boolean;reviewed:boolean;freeAllowlisted:boolean}> = [];
  const seen = new Set<string>();
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const rows = await env.AI.models({page, per_page:100});
    if (!Array.isArray(rows)) throw new Error("Каталог вернул неизвестный формат.");
    let added = 0;
    for (const m of rows) {
      if (!m.name || seen.has(m.name)) continue;
      seen.add(m.name); added++;
      models.push({slug:m.name, task:m.task?.name ?? "unknown", hosted:m.name.startsWith("@cf/"),
        reviewed:!!findModel(m.name), freeAllowlisted:FREE_MODEL_SLUGS.has(m.name)});
    }
    if (rows.length < 100) {complete = true; break;}
    if (added === 0) break;
  }
  return {models, returnedCount:models.length, complete, fetchedAt:new Date().toISOString(),
    scope:"Workers AI binding catalog; dashboard and third-party catalog may differ"};
}
