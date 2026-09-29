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
    expect(shell).toContain('data-src="/pulse-globe.html"');
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


describe("System observability drawer", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");
  const api = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");

  it("показывает только реальные runtime данные", () => {
    expect(shell).toContain('id="systemPanel"');
    expect(shell).toContain('id="systemOpen"');
    expect(shell).not.toContain("SYSTEM ONLINE");
    expect(client).toContain("/api/azrail/metrics?projectId=");
    expect(client).toContain("/api/azrail/routing-settings");
  });

  it("защищает Project Workspace и metrics ownership проверкой", () => {
    expect(api).toContain('await requireResource(env, principal, "project", projectId);');
    expect(api).toContain('await requireResource(env,principal,"project",project);');
  });

  it("не содержит хвостового дублированного runtime", () => {
    expect(client.split("})();").length - 1).toBe(1);
    expect(client.split("$('systemOpen').addEventListener").length - 1).toBe(1);
    expect(client.split("$('projectsOpen').addEventListener").length - 1).toBe(1);
  });
});


describe("Standalone System view", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const system = fs.readFileSync(path.join(root, "public/system.js"), "utf8");

  it("имеет одну системную точку входа без мёртвого drawer JS", () => {
    expect(shell.split('href="/system.html"').length - 1).toBe(1);
    expect(shell).not.toContain('id="systemOpen"');
    expect(shell).not.toContain(".catalog-body");
    expect(shell).not.toContain("\\n");
  });

  it("читает только реальные runtime API", () => {
    expect(system).toContain("/api/azrail/me");
    expect(system).toContain("/api/azrail/routing-settings");
    expect(system).toContain("/api/azrail/metrics");
    expect(system).not.toMatch(/innerHTML\s*=/);
  });
});


describe("Measured System observability", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const pulse = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");
  const system = fs.readFileSync(path.join(root, "public/system.js"), "utf8");

  it("сохраняет только выданный сервером write budget", () => {
    expect(pulse).toContain("if(d.budget)cached('azrail_pulse_write_budget',JSON.stringify(d.budget))");
    expect(system).toContain("azrail_pulse_write_budget");
  });

  it("показывает фактические metering и routing policy поля", () => {
    expect(system).toContain("monthlyBudgetUsd");
    expect(system).toContain("committedUsd");
    expect(system).toContain("unknown_cost_calls");
    expect(system).toContain("measured_micro_usd");
    expect(system).toContain("mean_ms");
    expect(system).toContain("gatewayConfigured");
    expect(system).toContain("workersPlan");
  });

  it("не содержит декоративных числовых метрик", () => {
    expect(system).not.toMatch(/Math\.random\(\).*metric/i);
    expect(system).not.toMatch(/fake|demo metric|placeholder metric/i);
    expect(system).not.toMatch(/innerHTML\s*=/);
  });
});


describe("Canonical Pulse entrypoint", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
  const wrangler = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");

  it("отдаёт Pulse на корне и HTML fallback", () => {
    expect(index).toContain('incomingUrl.pathname === "/"');
    expect(index).toContain('new URL("/pulse.html", incomingUrl)');
    expect(index).toContain('new URL("/pulse.html", url)');
  });

  it("запускает Worker первым только для root и API", () => {
    expect(wrangler).toContain('run_worker_first = [ "/", "/api/*" ]');
  });

  it("сохраняет legacy и advanced assets", () => {
    expect(fs.existsSync(path.join(root, "public/index.html"))).toBe(true);
    expect(fs.existsSync(path.join(root, "public/ultimate.html"))).toBe(true);
    expect(fs.existsSync(path.join(root, "public/pulse.html"))).toBe(true);
  });
});


describe("Staging isolation", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const production = fs.readFileSync(path.join(root, "wrangler.toml"), "utf8");
  const staging = fs.readFileSync(path.join(root, "wrangler.staging.toml"), "utf8");
  const guard = fs.readFileSync(path.join(root, "scripts/check-staging.mjs"), "utf8");
  const capture = (text: string, re: RegExp) => re.exec(text)?.[1];

  it("использует отдельные имена хранилищ и force-free", () => {
    expect(staging).toContain('database_name = "azrail-db-staging"');
    expect(staging).toContain('bucket_name = "azrail-artifacts-staging"');
    expect(staging).toContain('AZRAIL_FORCE_FREE = "true"');
    expect(staging).toContain('AZRAIL_WRITE_BUDGET = "1000"');
  });

  it("не содержит production resource identifiers", () => {
    const prodD1 = capture(production,/database_id\\s*=\\s*"([^"]+)"/);
    const prodKv = capture(production,/\\[\\[kv_namespaces\\]\\][\\s\\S]*?\\nid\\s*=\\s*"([^"]+)"/);
    expect(prodD1).toBeTruthy(); expect(prodKv).toBeTruthy();
    expect(staging).not.toContain(String(prodD1));
    expect(staging).not.toContain(String(prodKv));
  });

  it("не включает production Sandbox и guard проверяет placeholders", () => {
    expect(staging).not.toContain("[[containers]]");
    expect(staging).not.toContain("AZRAIL_SANDBOX");
    expect(guard).toContain("REPLACE_[A-Z0-9_]+");
    expect(guard).toContain("Staging D1 must not equal production D1");
    expect(guard).toContain("Staging R2 must not equal production R2");
  });
});


describe("Presence ownership and deferred Globe", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const index = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
  const shell = fs.readFileSync(path.join(root, "public/pulse.html"), "utf8");
  const client = fs.readFileSync(path.join(root, "public/pulse.js"), "utf8");

  it("не связывает heartbeat с чужим Project", () => {
    const start = index.indexOf('url.pathname === "/api/presence" && request.method === "POST"');
    const block = index.slice(start, start + 900);
    expect(block).toContain('requireResource(env, principal, "project", presenceProject)');
    expect(block.indexOf("requireResource")).toBeLessThan(block.indexOf("heartbeatPresence"));
  });

  it("грузит Globe после первичного UI paint", () => {
    expect(shell).toContain('data-src="/pulse-globe.html"');
    expect(shell).not.toContain('id="pulseGlobe" src="/pulse-globe.html"');
    expect(client).toContain("function loadGlobe()");
    expect(client).toContain("requestIdleCallback");
  });
});
