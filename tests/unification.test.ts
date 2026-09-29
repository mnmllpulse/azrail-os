import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { canonicalApiPath } from "../src/protocol/facade";
import { validateProjectDescription, validateProjectName } from "../src/lib/projects-api";
import { capabilitiesForMode, defaultIterationsForMode, normalizeRoutingMode, tierPreferenceForMode } from "../src/lib/routing-mode";
import { modeForStudio, routeStudio } from "../src/lib/studio-router";

describe("Pulse OS → AZRAIL facade", () => {
  it("нормализует mission API до старого защищённого маршрута", () => {
    expect(canonicalApiPath("/api/azrail/mission")).toBe("/api/mission");
    expect(canonicalApiPath("/api/azrail/mission/cancel")).toBe("/api/mission/cancel");
    expect(canonicalApiPath("/api/azrail/mission/hint")).toBe("/api/mission/hint");
    expect(canonicalApiPath("/api/azrail/presence")).toBe("/api/presence");
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


describe("Pulse Shell security invariants", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");

  it("не хранит access token в localStorage или URL", () => {
    expect(client).not.toContain("localStorage");
    expect(client).not.toMatch(/[?&](token|access_token)=/);
    expect(client).toContain("sessionStorage");
  });

  it("использует только AZRAIL facade для mission/project flow", () => {
    expect(client).toContain("/api/azrail/projects");
    expect(client).toContain("/api/azrail/mission");
    expect(client).toContain("/api/azrail/me");
    expect(client).not.toContain("location.href='/ultimate.html?");
  });

  it("глобус изолирован отдельным документом и не блокирует composer", () => {
    expect(shell).toContain('src="/pulse-globe.html"');
    expect(shell).toContain('id="composer"');
    expect(shell).toContain('src="/pulse.js"');
  });
});


describe("Routing profiles", () => {
  it("оставляет AUTO на политике intent", () => {
    expect(normalizeRoutingMode("something-else")).toBe("auto");
    expect(tierPreferenceForMode("auto")).toBeNull();
  });

  it("FAST и DEEP действительно меняют порядок tier", () => {
    expect(tierPreferenceForMode("fast")).toEqual(["fast","balanced","frontier"]);
    expect(tierPreferenceForMode("deep")).toEqual(["frontier","balanced","fast"]);
    expect(defaultIterationsForMode("fast")).toBeLessThan(defaultIterationsForMode("deep"));
  });

  it("CODE требует coding capability", () => {
    expect(capabilitiesForMode("code")).toEqual(["coding"]);
  });
});

describe("Pulse Globe production boundary", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(path.join(root, "public/pulse-globe.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "src/ui/pulse-globe.mjs"), "utf8");
  const build = fs.readFileSync(path.join(root, "scripts/build-pulse.mjs"), "utf8");

  it("не грузит Three.js с CDN", () => {
    expect(html).not.toMatch(/unpkg|jsdelivr|cdnjs/i);
    expect(html).toContain('src="/pulse-globe.js"');
    expect(source).toContain('from "three"');
  });

  it("собирается отдельным lazy asset", () => {
    expect(build).toContain('outfile: "public/pulse-globe.js"');
    expect(source).toContain('pulse:presence');
    expect(source).toContain('pulse:globe-ready');
  });
});


describe("Project Workspace shell", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");
  const api = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");

  it("использует единый workspace endpoint", () => {
    expect(client).toContain("/workspace");
    expect(api).toContain("loadProjectWorkspace");
    expect(api).toMatch(/\/api\\\/projects\\\/\(\[\^\/\]\+\)\\\/workspace/);
  });

  it("не вставляет данные проекта через innerHTML", () => {
    expect(client).not.toContain(".innerHTML");
    expect(client).toContain("textContent");
    expect(shell).toContain('id="projectsPanel"');
  });

  it("переключение проекта меняет канонический project id", () => {
    expect(client).toContain("cached('azrail_pulse_project',project)");
    expect(client).toContain("heartbeatPresence()");
  });
});


describe("Studio and Labs consolidation", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");
  const registry = JSON.parse(fs.readFileSync(path.join(root, "public/pulse-studios.json"), "utf8"));

  it("оставляет один Composer вместо отдельных runtime студий", () => {
    expect(shell).toContain('id="studiosOpen"');
    expect(shell).toContain('id="labsOpen"');
    expect(shell).toContain('href="/ultimate.html">ADVANCED</a>');
    expect(shell).not.toContain('/ultimate.html#studio');
    expect(shell).not.toContain('/ultimate.html#labs');
    expect(client).toContain("fetch('/pulse-studios.json'");
    expect(client).toContain("$('idea').value=item.prompt");
  });

  it("имеет небольшой верхний каталог и сохраняет legacy capabilities внутри", () => {
    expect(Array.isArray(registry.studios)).toBe(true);
    expect(registry.studios.length).toBeGreaterThanOrEqual(5);
    expect(registry.studios.length).toBeLessThanOrEqual(10);
    const ids = new Set(registry.studios.map((x: { id: string }) => x.id));
    expect(ids.has("development")).toBe(true);
    expect(ids.has("creative")).toBe(true);
    expect(ids.has("agents")).toBe(true);
    expect(ids.has("pulse-lab")).toBe(true);
    const modules = registry.studios.flatMap((x: { modules?: string[] }) => x.modules ?? []);
    expect(modules).toContain("QuantumAgentOrchestrator");
    expect(modules).toContain("CodeStudioPanel");
  });

  it("не использует innerHTML для project/studio данных", () => {
    expect(client).not.toMatch(/innerHTML\s*=/);
  });
});


describe("Automatic Studio routing", () => {
  it("маршрутизирует очевидные задачи без вызова модели", () => {
    expect(routeStudio("Исправь TypeScript ошибки и тесты").studio).toBe("development");
    expect(routeStudio("Подготовь дизайн интерфейса и визуальный стиль").studio).toBe("creative");
    expect(routeStudio("Сделай анализ музыкальной аранжировки трека").studio).toBe("audio");
    expect(routeStudio("Настрой Cloudflare deploy и observability").studio).toBe("operations");
    expect(routeStudio("Проведи benchmark и измерь результат").studio).toBe("pulse-lab");
  });

  it("уважает явный Studio hint и оставляет спорное на AUTO", () => {
    expect(routeStudio("Любая задача", "agents").studio).toBe("agents");
    expect(routeStudio("Привет, помоги с идеей").studio).toBe("auto");
  });

  it("преобразует Studio в реальный routing mode", () => {
    expect(modeForStudio("development")).toBe("code");
    expect(modeForStudio("audio")).toBe("creative");
    expect(modeForStudio("intelligence")).toBe("deep");
    expect(modeForStudio("operations")).toBe("balanced");
  });
});

describe("Consolidation regressions", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");
  const api = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");

  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("не возвращает дубли Projects/Studio/Advanced", () => {
    expect(count(shell, 'id="projectsPanel"')).toBe(1);
    expect(count(shell, 'id="studioCatalog"')).toBe(1);
    expect(count(shell, 'id="capabilitiesPanel"')).toBe(0);
    expect(count(shell, 'href="/ultimate.html"')).toBe(1);
    expect(count(client, "async function openProjects(")).toBe(1);
    expect(count(client, "$('projectsOpen').addEventListener")).toBe(1);
  });

  it("передаёт явный Studio hint через тот же mission API", () => {
    expect(client).toContain("preferredStudio:studioHint||undefined");
    expect(api).toContain("normalizePreferredStudio(body.preferredStudio)");
    expect(api).toContain("routeStudio(goal");
  });

  it("считает write budget после разрешения AUTO → Studio → Mode", () => {
    expect(api).toContain("estimateMissionWrites(maxIterations)");
    expect(api.indexOf("const studioRoute = routeStudio")).toBeLessThan(api.indexOf("const budget = await chargeWrites"));
  });
});


describe("SYSTEM observability drawer", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");

  const count = (text: string, needle: string) => text.split(needle).length - 1;

  it("имеет ровно один SYSTEM drawer и один opener", () => {
    expect(count(shell, 'id="systemPanel"')).toBe(1);
    expect(count(shell, 'id="systemOpen"')).toBe(1);
    expect(count(client, "async function openSystem(")).toBe(1);
    expect(count(client, "$('systemOpen').addEventListener")).toBe(1);
  });

  it("показывает только реальные health / routing / project metrics", () => {
    expect(client).toContain("fetch('/health'");
    expect(client).toContain("/api/azrail/routing-settings");
    expect(client).toContain("/api/azrail/metrics?projectId=");
    expect(client).toContain("measured_micro_usd");
    expect(client).toContain("unknown_cost_calls");
  });

  it("не вставляет runtime-данные через innerHTML", () => {
    expect(client).not.toMatch(/innerHTML\s*=/);
  });

  it("не содержит старый удалённый master-detail Studio CSS", () => {
    expect(shell).not.toContain(".catalog-body{");
    expect(shell).not.toContain('id="capabilitiesPanel"');
  });
});
