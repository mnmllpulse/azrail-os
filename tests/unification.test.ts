import { describe, expect, it } from "vitest";
import { canonicalApiPath } from "../src/protocol/facade";
import { validateProjectDescription, validateProjectName } from "../src/lib/projects-api";

describe("Pulse OS → AZRAIL facade", () => {
  it("нормализует mission API до старого защищённого маршрута", () => {
    expect(canonicalApiPath("/api/azrail/mission")).toBe("/api/mission");
    expect(canonicalApiPath("/api/azrail/mission/cancel")).toBe("/api/mission/cancel");
    expect(canonicalApiPath("/api/azrail/mission/hint")).toBe("/api/mission/hint");
  });

  it("сохраняет project suffix", () => {
    expect(canonicalApiPath("/api/azrail/projects/abc/versions")).toBe("/api/projects/abc/versions");
  });

  it("не переписывает неизвестные маршруты", () => {
    expect(canonicalApiPath("/api/azrail/admin/secret")).toBe("/api/azrail/admin/secret");
    expect(canonicalApiPath("/health")).toBe("/health");
  });
});

describe("Project-first input validation", () => {
  it("нормализует название", () => {
    expect(validateProjectName("  Pulse Lab  ")).toBe("Pulse Lab");
  });

  it("отклоняет пустое и слишком длинное название", () => {
    expect(() => validateProjectName("   ")).toThrow();
    expect(() => validateProjectName("x".repeat(121))).toThrow();
  });

  it("ограничивает описание", () => {
    expect(validateProjectDescription(undefined)).toBeNull();
    expect(validateProjectDescription("  core  ")).toBe("core");
    expect(() => validateProjectDescription("x".repeat(2001))).toThrow();
  });
});
