import type { Env } from "../types";
import { readModelPolicy } from "./model-policy";
import { positiveLimit } from "./quota";

interface CountRow { status: string; count: number }
interface ModelAggregate {
  calls: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  measured_micro_usd: number | null;
  reserved_micro_usd: number | null;
  unknown_cost_calls: number | null;
  mean_ms: number | null;
}
interface TopModelRow {
  model: string;
  calls: number;
  input_tokens: number | null;
  output_tokens: number | null;
  measured_micro_usd: number | null;
  unknown_cost_calls: number;
}
interface SpendRow { limit_micro_usd: number; spent_micro_usd: number }
interface QuotaRow { used: number }

const usd = (micro: number | null | undefined) => (micro ?? 0) / 1_000_000;

export async function projectObservability(env: Env, projectId: string) {
  const missionScopeSql = "scope=? OR scope IN (SELECT 'mission:'||id FROM missions WHERE project_id=?)";
  const monthScope = `paid-month:${new Date().toISOString().slice(0, 7)}`;
  const bucket = Math.floor(Date.now() / 3_600_000);

  const [missionRows, modelAggregate, topModels, monthSpend, missionBudgets, writeQuota, policy] = await Promise.all([
    env.AZRAIL_D1.prepare(
      "SELECT status,COUNT(*) AS count FROM missions WHERE project_id=? GROUP BY status",
    ).bind(projectId).all<CountRow>(),

    env.AZRAIL_D1.prepare(
      `SELECT
         COUNT(*) AS calls,
         SUM(prompt_tokens) AS input_tokens,
         SUM(completion_tokens) AS output_tokens,
         SUM(actual_micro_usd) AS measured_micro_usd,
         SUM(reserved_micro_usd) AS reserved_micro_usd,
         SUM(CASE WHEN actual_micro_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_calls,
         AVG(CASE WHEN finished_at IS NOT NULL THEN finished_at-started_at END) AS mean_ms
       FROM model_calls
       WHERE ${missionScopeSql}`,
    ).bind(`project:${projectId}`, projectId).first<ModelAggregate>(),

    env.AZRAIL_D1.prepare(
      `SELECT
         model,
         COUNT(*) AS calls,
         SUM(prompt_tokens) AS input_tokens,
         SUM(completion_tokens) AS output_tokens,
         SUM(actual_micro_usd) AS measured_micro_usd,
         SUM(CASE WHEN actual_micro_usd IS NULL THEN 1 ELSE 0 END) AS unknown_cost_calls
       FROM model_calls
       WHERE ${missionScopeSql}
       GROUP BY model
       ORDER BY calls DESC
       LIMIT 8`,
    ).bind(`project:${projectId}`, projectId).all<TopModelRow>(),

    env.AZRAIL_D1.prepare(
      "SELECT limit_micro_usd,spent_micro_usd FROM spend_limits WHERE scope=?",
    ).bind(monthScope).first<SpendRow>(),

    env.AZRAIL_D1.prepare(
      `SELECT
         COALESCE(SUM(limit_micro_usd),0) AS limit_micro_usd,
         COALESCE(SUM(spent_micro_usd),0) AS spent_micro_usd
       FROM spend_limits
       WHERE scope IN (SELECT 'mission:'||id FROM missions WHERE project_id=?)`,
    ).bind(projectId).first<SpendRow>(),

    env.AZRAIL_D1.prepare(
      "SELECT used FROM request_quotas WHERE scope='writes:shared' AND bucket=?",
    ).bind(bucket).first<QuotaRow>(),

    readModelPolicy(env),
  ]);

  const models = modelAggregate ?? {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    measured_micro_usd: 0,
    reserved_micro_usd: 0,
    unknown_cost_calls: 0,
    mean_ms: 0,
  };

  const writeLimit = positiveLimit(env.AZRAIL_WRITE_BUDGET, 5000);
  const writeUsed = writeQuota?.used ?? 0;
  const monthLimit = monthSpend?.limit_micro_usd ?? Math.round(policy.monthlyBudgetUsd * 1_000_000);
  const monthUsed = monthSpend?.spent_micro_usd ?? 0;

  return {
    projectId,
    generatedAt: new Date().toISOString(),
    runtime: {
      workersPlan: env.AZRAIL_WORKERS_PLAN ?? "unknown",
      metering: env.AZRAIL_METERING ?? "off",
      gatewayConfigured: !!env.AI_GATEWAY_ID,
    },
    routing: {
      allowThirdPartyModels: policy.allowThirdPartyModels,
      forceFree: policy.forceFree,
      ready: policy.ready,
      revision: policy.revision,
    },
    missions: Object.fromEntries((missionRows.results ?? []).map((row) => [row.status, row.count])),
    models: {
      calls: models.calls ?? 0,
      inputTokens: models.input_tokens ?? 0,
      outputTokens: models.output_tokens ?? 0,
      measuredUsd: usd(models.measured_micro_usd),
      reservedUsd: usd(models.reserved_micro_usd),
      unknownCostCalls: models.unknown_cost_calls ?? 0,
      meanLatencyMs: Math.round(models.mean_ms ?? 0),
      top: (topModels.results ?? []).map((row) => ({
        model: row.model,
        calls: row.calls,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        measuredUsd: usd(row.measured_micro_usd),
        unknownCostCalls: row.unknown_cost_calls ?? 0,
      })),
    },
    budgets: {
      month: {
        month: monthScope.slice("paid-month:".length),
        limitUsd: usd(monthLimit),
        committedUsd: usd(monthUsed),
        remainingUsd: Math.max(0, usd(monthLimit - monthUsed)),
      },
      projectMissions: {
        limitUsd: usd(missionBudgets?.limit_micro_usd),
        committedUsd: usd(missionBudgets?.spent_micro_usd),
      },
      writesShared: {
        used: writeUsed,
        limit: writeLimit,
        remaining: Math.max(0, writeLimit - writeUsed),
        resetAt: new Date((bucket + 1) * 3_600_000).toISOString(),
      },
    },
    caveats: {
      measuredCostIncomplete: (models.unknown_cost_calls ?? 0) > 0,
      measuredCostNote:
        "Measured USD excludes calls whose provider did not return complete token usage. Reserved USD is not actual spend.",
      writeBudgetNote:
        "Write quota is a shared protective estimate, not a Cloudflare billing counter.",
    },
  };
}
