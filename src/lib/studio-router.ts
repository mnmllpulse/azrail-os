import { quickIntent } from "./quick-intent";
import type { RoutingMode } from "./routing-mode";

export type StudioId =
  | "development"
  | "creative"
  | "audio"
  | "intelligence"
  | "agents"
  | "operations"
  | "pulse-lab"
  | "auto";

export interface StudioRoute {
  studio: StudioId;
  source: "explicit" | "heuristic" | "fallback";
  reason: string;
}

const STUDIO_IDS = new Set<StudioId>([
  "development","creative","audio","intelligence","agents","operations","pulse-lab","auto",
]);

export function normalizePreferredStudio(value: unknown): StudioId | null {
  return typeof value === "string" && STUDIO_IDS.has(value as StudioId) && value !== "auto"
    ? value as StudioId
    : null;
}

function has(text: string, re: RegExp): boolean {
  return re.test(text);
}

export function routeStudio(message: string, preferred?: StudioId | null): StudioRoute {
  if (preferred && preferred !== "auto") {
    return { studio: preferred, source: "explicit", reason: "Пользователь выбрал направление Studio/Lab." };
  }

  const text = (message ?? "").trim();
  if (!text) return { studio: "auto", source: "fallback", reason: "Нет текста для уверенной маршрутизации." };

  const intent = quickIntent(text);
  if (intent === "generate_ui") {
    return { studio: "creative", source: "heuristic", reason: "Запрос явно относится к UI/дизайну." };
  }
  if (intent === "generate_code") {
    return { studio: "development", source: "heuristic", reason: "Запрос явно относится к созданию/изменению кода." };
  }

  if (has(text, /(?:музык|аудио|трек|аранжиров|мелоди|ритм|саунд|mix|master|beatport)/iu)) {
    return { studio: "audio", source: "heuristic", reason: "Обнаружена аудио/музыкальная задача." };
  }
  if (has(text, /(?:агент|оркестратор|orchestrator|swarm|мультиагент|agent forge|capabilit)/iu)) {
    return { studio: "agents", source: "heuristic", reason: "Обнаружена агентная/оркестрационная задача." };
  }
  if (has(text, /(?:деплой|deploy|cloudflare|vercel|billing|бюджет|стоимост|observability|лог|метрик|интеграц|pipeline|ci\/cd)/iu)) {
    return { studio: "operations", source: "heuristic", reason: "Обнаружена production/operations задача." };
  }
  if (has(text, /(?:эксперимент|benchmark|бенч|лаборатор|vector|вектор|гипотез|измери|ab test|a\/b)/iu)) {
    return { studio: "pulse-lab", source: "heuristic", reason: "Обнаружена экспериментальная/измерительная задача." };
  }
  if (has(text, /(?:исслед|research|сравни|анализ документ|knowledge|данн|analytics|модел|каталог моделей)/iu)) {
    return { studio: "intelligence", source: "heuristic", reason: "Обнаружена research/data/intelligence задача." };
  }
  if (has(text, /(?:дизайн|ui|ux|интерфейс|изображ|график|иллюстрац|видео|visual|brand|бренд)/iu)) {
    return { studio: "creative", source: "heuristic", reason: "Обнаружена визуальная/creative задача." };
  }
  if (has(text, /(?:код|репозитор|bug|ошибк|typescript|javascript|react|worker|api|тест|архитектур)/iu)) {
    return { studio: "development", source: "heuristic", reason: "Обнаружена инженерная задача." };
  }

  return { studio: "auto", source: "fallback", reason: "Уверенное направление не найдено; решение остаётся за AZRAIL." };
}

export function modeForStudio(studio: StudioId): RoutingMode {
  switch (studio) {
    case "development": return "code";
    case "creative":
    case "audio": return "creative";
    case "intelligence":
    case "agents":
    case "pulse-lab": return "deep";
    case "operations": return "balanced";
    case "auto":
    default: return "auto";
  }
}
