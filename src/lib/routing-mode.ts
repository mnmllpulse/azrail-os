import type { ModelCapability, ModelTier } from "./model-registry";

export type RoutingMode = "auto" | "fast" | "balanced" | "deep" | "creative" | "code";

const MODES = new Set<RoutingMode>(["auto","fast","balanced","deep","creative","code"]);

export function normalizeRoutingMode(value: unknown): RoutingMode {
  return typeof value === "string" && MODES.has(value as RoutingMode)
    ? value as RoutingMode
    : "auto";
}

export function defaultIterationsForMode(mode: RoutingMode): number {
  switch (mode) {
    case "fast": return 4;
    case "deep": return 12;
    case "code": return 10;
    case "balanced":
    case "creative":
    case "auto":
    default: return 8;
  }
}

export function tierPreferenceForMode(mode: RoutingMode | undefined): ModelTier[] | null {
  switch (mode) {
    case "fast": return ["fast","balanced","frontier"];
    case "balanced": return ["balanced","frontier","fast"];
    case "deep":
    case "code": return ["frontier","balanced","fast"];
    case "creative": return ["balanced","frontier","fast"];
    case "auto":
    default: return null;
  }
}

export function capabilitiesForMode(mode: RoutingMode | undefined): ModelCapability[] {
  return mode === "code" ? ["coding"] : [];
}
