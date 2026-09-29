import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";

/**
 * ПЛАНЕТА И ОБЪЕДИНЁННЫЕ МОДУЛИ.
 *
 * Две отдельные истории, проверяемые одним файлом, потому что они про
 * одно и то же изменение.
 *
 * ПЕРВАЯ — планета. Трёхмерная Земля здесь уже была и была удалена: она
 * тянула three.js с чужого адреса (без сети страница не поднималась) и
 * занимала на телефоне весь первый экран, отодвигая поле ввода за нижний
 * край. Возврат знака НЕ ДОЛЖЕН вернуть ни того, ни другого. Проверки
 * ниже держат обе границы: ноль внешних ресурсов и нулевой вклад в
 * высоту шапки на узком экране.
 *
 * ВТОРАЯ — модули. До этой правки бэкенд отдавал в пустоту девять групп
 * маршрутов: метрики, копии, спасение миссий, память, версии, журнал
 * проекта, политику маршрутизации, живой каталог моделей и весь
 * /api/admin/*. Ни одна строка главного экрана их не читала — работающий
 * код, к которому нет дороги из интерфейса, неотличим от ненаписанного.
 *
 * ЧЕСТНО О ГРАНИЦАХ: это статический разбор файла, а не браузер. Здесь
 * ловится «маршрут снова отвалился от экрана» и «обработчик потерял
 * разметку» — тот же класс, что уже случался в этом проекте трижды.
 * Отрисовку это не заменяет и не притворяется, что заменяет.
 */

const html = readFileSync("public/index.html", "utf8");

const script = (): string => {
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return m ? m[1] : "";
};

/** Разбор CSS на media-блоки — тот же приём, что в tests/frontend.test.ts. */
function mediaBlocks(): Array<{ condition: string; body: string }> {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
    .map((m) => m[1])
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "\n");
  const out: Array<{ condition: string; body: string }> = [];
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) break;
    const open = css.indexOf("{", at);
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    out.push({ condition: css.slice(at + 6, open).trim(), body: css.slice(open + 1, j - 1) });
    i = j;
  }
  return out;
}

describe("Планета", () => {
  it("разметка есть и она одна", () => {
    expect(html).toContain('<canvas id="globe">');
    expect((html.match(/id="globe"/g) ?? []).length).toBe(1);
  });

  it("рисуется своими руками, без единого внешнего ресурса", () => {
    // Ровно то, из-за чего удалили предыдущую сцену: библиотека с чужого
    // адреса — плата за оформление временем загрузки и работой без сети.
    const externals = [...html.matchAll(/(?:src|from)\s*=?\s*["'](https?:\/\/[^"']+)/g)].map((m) => m[1]);
    expect(externals, `внешние ресурсы: ${externals.join(", ")}`).toEqual([]);
    expect(script(), "холст должен получать 2D-контекст, а не WebGL").toContain("getContext('2d')");
    // Упоминание three.js в комментарии — это память о том, почему сцену
    // убрали, и её стирать не за чем. Запрещено подключение, а не слово.
    expect(html).not.toMatch(/(?:src|import)[^\n]*three(?:\.min)?\.js/i);
    expect(script(), "WebGL тянет за собой всё то же самое").not.toContain("webgl");
  });

  it("вращение медленное — иначе движение перетягивает внимание с поля ввода", () => {
    const m = /var SPIN = ([\d.]+)/.exec(script());
    expect(m, "скорость вращения не найдена").toBeTruthy();
    const spin = Number(m![1]);
    // Полный оборот не быстрее минуты: всё, что быстрее, читается боковым
    // зрением как мигание, а не как фон.
    expect(spin).toBeGreaterThan(0);
    expect((2 * Math.PI) / spin, "оборот быстрее минуты").toBeGreaterThan(60);
  });

  it("колец несколько и у каждого свой наклон", () => {
    const body = script().slice(script().indexOf("var RINGS"), script().indexOf("var NODES"));
    const incs = [...body.matchAll(/inc:\s*(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(incs.length, "колец меньше трёх").toBeGreaterThanOrEqual(3);
    expect(new Set(incs).size, "наклоны колец совпадают — кольца сольются в одно").toBe(incs.length);
  });

  it("на телефоне планета НЕ добавляет высоты шапке", () => {
    // Главная причина, по которой прошлую сцену убрали. Планета уходит из
    // потока (position:absolute) — высота шапки не меняется ни на пиксель.
    const phone = mediaBlocks().filter(
      (b) => /max-width:\s*(6[5-9]\d|[78]\d\d)px/.test(b.condition) && b.body.includes(".globe-stage"),
    );
    expect(phone.length, "правил планеты для узкого экрана нет").toBeGreaterThan(0);
    expect(phone.map((b) => b.body).join(";")).toMatch(/position\s*:\s*absolute/);
  });

  it("движение подчиняется общему переключателю и вкладке на фоне", () => {
    const js = script();
    expect(js).toContain("classList.contains('motion')");
    expect(js, "кадры продолжают считаться в свёрнутой вкладке").toContain("!document.hidden");
    // При выключенном движении шар обязан остаться нарисованным: пустой
    // прямоугольник читается как незагрузившаяся картинка, а не как
    // уважение к настройке.
    expect(js).toMatch(/else\s*\{\s*render\(clock\);/);
  });

  it("шаг кадра ограничен — возврат к свёрнутой вкладке не проматывает планету рывком", () => {
    expect(script()).toMatch(/Math\.min\(\(now - last\) \/ 1000, 0\.2\)/);
  });
});

describe("Объединение модулей: маршруты снова доступны из интерфейса", () => {
  const js = script();

  // Каждый пункт — маршрут, который сервер отдавал в пустоту до этой правки.
  const routes: Array<[string, string]> = [
    ["метрики проекта", "/api/metrics?projectId="],
    ["список копий", "/api/backups?projectId="],
    ["восстановление копии", "/api/backups/restore"],
    ["спасение миссии", "/api/mission/recover"],
    ["политика маршрутизации", "/api/routing-settings"],
    ["смена политики", "/api/admin/routing-settings"],
    ["живой каталог моделей", "/api/model-catalog"],
    ["аккаунты доступа", "/api/admin/accounts"],
    ["отзыв доступа", "/api/admin/accounts/revoke"],
    ["разрешения проекта", "/api/admin/permissions"],
    ["владелец ресурса", "/api/admin/ownership"],
    ["тарифы и бюджеты", "/api/admin/billing"],
  ];

  it.each(routes)("%s: %s читается с главного экрана", (_name, route) => {
    expect(js).toContain(route);
  });

  it("память, версии и журнал проекта строятся по идентификатору проекта", () => {
    for (const tail of ["/memory", "/versions", "/history"]) {
      expect(js, `нет обращения к ${tail}`).toContain(
        "'/api/projects/' + encodeURIComponent(currentProject) + '" + tail + "'",
      );
    }
    // Удаление факта — единственный способ отменить неверный вывод,
    // который агент иначе применяет ко всем будущим задачам проекта.
    expect(js).toContain("method: 'DELETE'");
  });

  it("каждый новый экран объявлен в списке экранов", () => {
    const m = /var VIEWS = \[([\s\S]*?)\];/.exec(js);
    expect(m, "список экранов не найден").toBeTruthy();
    for (const view of ["viewStudios", "viewProject", "viewMemory", "viewModels", "viewAdmin"]) {
      // Пункт меню, которого нет в списке, молча открывает главную:
      // кнопка нажимается, ничего не происходит, ошибки нет.
      expect(m![1], `${view} не в VIEWS`).toContain(view);
      expect(html, `нет секции ${view}`).toContain(`id="${view}"`);
      expect(html, `нет пункта меню для ${view}`).toContain(`data-open="${view}"`);
    }
  });

  it("у каждого пункта меню есть экран, а у каждого экрана — пункт меню", () => {
    const inMenu = new Set([...html.matchAll(/data-open="(\w+)"/g)].map((m) => m[1]));
    const sections = new Set([...html.matchAll(/<section class="view[^"]*" id="(\w+)"/g)].map((m) => m[1]));
    for (const id of inMenu) expect(sections.has(id), `пункт меню ${id} ведёт в никуда`).toBe(true);
  });

  it("данные с сервера попадают в разметку узлами, а не строкой", () => {
    // Имена аккаунтов, ключи памяти и тексты ошибок приходят снаружи.
    // Подстановка строкой здесь была бы дырой — правило по всему проекту.
    const from = js.indexOf("function modItem");
    const to = js.indexOf("function modEmpty");
    expect(from, "modItem не найдена").toBeGreaterThan(0);
    const fn = js.slice(from, to);
    expect(fn).toContain("document.createElement");
    expect(fn).not.toContain("innerHTML");
  });

  it("разделы без токена сообщают о настройке, а не об ошибке", () => {
    // Разница существенная: слово «ошибка» отправляет чинить то, что не
    // сломано, — а не туда, где лежит незаполненное поле.
    expect(js).toContain("Нужен сохранённый токен");
  });

  it("администрирование скрыто от всех, кроме владельца", () => {
    // Сервер откажет на каждом маршруте раздела. Видимая кнопка,
    // гарантированно возвращающая 403, — обещание несуществующего.
    expect(html).toContain('id="navAdmin"');
    expect(html).toMatch(/id="navAdmin"[^>]*class=|class="[^"]*hidden[^"]*"[^>]*id="navAdmin"/);
    expect(js).toContain("$('navAdmin').classList.toggle('hidden', myRole !== 'admin')");
  });

  it("необратимое спрашивает подтверждение", () => {
    for (const marker of ["Восстановить копию", "Забыть факт", "Отозвать доступ"]) {
      expect(js, `без подтверждения: ${marker}`).toContain(marker);
    }
    expect((js.match(/window\.confirm\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("неизвестная стоимость показывается отдельно и не выдаётся за ноль", () => {
    expect(js).toContain("стоимость неизвестна");
    expect(js).toContain("unknown_cost_calls");
  });

  it("прежние экраны остались доступны — ссылки, а не мёртвые файлы", () => {
    for (const page of ["/ultimate.html", "/control.html", "/classic.html"]) {
      expect(html, `потеряна ссылка на ${page}`).toContain(`href="${page}"`);
    }
  });

  it("скрипт остаётся одним блоком и разбирается целиком", () => {
    /* Второй <script> на странице уже однажды подозревали в поломке
       области видимости — и зря: детектор принимал `<script` внутри
       JS-строк за настоящий тег. Поэтому считаются теги В НАЧАЛЕ СТРОКИ,
       а не любое вхождение; блок здесь ровно один, и он обязан
       разбираться целиком, а не «до первой ошибки». */
    expect((html.match(/^<script/gm) ?? []).length).toBe(1);
    expect(js.length, "тело скрипта не выделилось").toBeGreaterThan(10000);
    expect(() => new Script(js)).not.toThrow();
  });
});

/**
 * РАЗРЕШЕНИЯ ПРОЕКТА ЧИТАЮТСЯ, А НЕ ТОЛЬКО ПИШУТСЯ.
 *
 * Пробел, найденный при сведении интерфейсов: выдать и отозвать
 * возможность было можно, а узнать текущее состояние — нет. Таблицу
 * project_permissions читала только проверка во время исполнения, и
 * снаружи это была запись вслепую: администратор нажимал «Выдать», на
 * экране ничего не менялось, и проверить результат можно было только
 * запуском задачи — то есть узнать о собственной настройке по отказу.
 */
describe("Разрешения проекта", () => {
  const server = readFileSync("src/index.ts", "utf8");
  const control = readFileSync("src/lib/project-control.ts", "utf8");

  it("список возможностей объявлен ОДИН раз", () => {
    expect(control).toContain("export const PROJECT_CAPABILITIES");
    // Тот же перечень строкой в нескольких местах расходится при первом
    // добавлении новой возможности — и расхождение обнаруживается не при
    // сборке, а отказом задачи у пользователя.
    const inline = [...server.matchAll(/\["git"\s*,\s*"deploy"\s*,\s*"sandbox"\s*,\s*"qa"\]/g)];
    expect(inline, "список возможностей снова размножен по файлам").toHaveLength(0);
    expect(server).toContain("PROJECT_CAPABILITIES");
  });

  it("состояние можно прочитать, и оно закрыто ролью администратора", () => {
    expect(server).toContain('url.pathname === "/api/admin/permissions" && request.method === "GET"');
    // Защита общая для всего /api/admin/ — отдельной проверки в обработчике
    // быть не должно, иначе появится второе место, где её можно забыть.
    const accounts = readFileSync("src/lib/accounts.ts", "utf8");
    expect(accounts).toContain('path.startsWith("/api/admin/")');
  });

  it("интерфейс показывает состояние сразу после записи", () => {
    const js = /<script[^>]*>([\s\S]*?)<\/script>/.exec(readFileSync("public/index.html", "utf8"))![1];
    expect(js).toContain("/api/admin/permissions?projectId=");
    // Именно это и было сломано: запись без последующего чтения.
    const setter = js.slice(js.indexOf("function setPermission"), js.indexOf("function loadPermissions"));
    expect(setter, "после записи состояние не перечитывается").toContain("loadPermissions()");
  });
});

/**
 * ТРЕТЬЯ ИСТОРИЯ — подключение любой модели вручную.
 *
 * Поломка была не в одном месте, а в трёх подряд, и починка любого
 * одного выглядела бы как работающая: (1) закреплённая модель искалась
 * только в зашитом реестре, (2) автоматический отбор шёл по тому же
 * зашитому списку, (3) выпадающее меню строилось из него же. Модель,
 * живая в аккаунте, но появившаяся после последнего выпуска AZRAIL,
 * была недоступна вообще никак. Проверки ниже держат все три звена
 * сразу — и отдельно держат границу, которую подключение НЕ сдвигает:
 * добавить модель значит получить право её выбрать, а не право тратить.
 */
describe("Новое: подключение любой модели вручную", () => {
  const custom = readFileSync("src/lib/custom-models.ts", "utf8");
  const router = readFileSync("src/lib/model-router.ts", "utf8");
  const policy = readFileSync("src/lib/model-policy.ts", "utf8");
  const idx = readFileSync("src/index.ts", "utf8");

  it("расширенный реестр — это зашитый плюс ручной, а не вместо", () => {
    // Подмена реестра ручным списком стоила бы работоспособности всем,
    // кто ничего не подключал.
    const fn = custom.slice(custom.indexOf("export async function effectiveRegistry"));
    expect(fn).toContain("...MODEL_REGISTRY");
    expect(fn, "проверенная запись должна побеждать одноимённую ручную").toContain("findModel(");
  });

  it("необходимость Gateway вычисляется из слага, а не приходит из формы", () => {
    // Модель не из @cf/ идёт через сторонний шлюз всегда. Флаг от
    // пользователя означал бы «отключить проверку галочкой».
    expect(custom).toContain('!slug.startsWith("@cf/")');
    const add = custom.slice(custom.indexOf("export async function addCustomModel"));
    expect(add, "признак Gateway не должен читаться из входных данных")
      .not.toMatch(/input\.requiresGateway/);
  });

  it("непроведённая миграция выглядит как пустой список, а не как отказ", () => {
    // Иначе рабочий маршрутизатор на старой базе читался бы как мёртвый.
    const list = custom.slice(custom.indexOf("export async function listCustomModels"));
    expect(list).toContain("catch");
    expect(list).toContain("return []");
  });

  it("источник данных обязателен — то же правило, что в проверенном реестре", () => {
    // Через полгода это единственное, по чему видно, что перепроверять.
    expect(custom).toMatch(/source[\s\S]{0,400}CustomModelError/);
  });

  it("закрепление и автоотбор читают один и тот же расширенный реестр", () => {
    expect(router).toContain("findAnyModel(env, req.preferredModel)");
    expect(policy).toContain("await effectiveRegistry(env)");
    expect(policy, "зашитый реестр напрямую в отборе — возврат поломки")
      .not.toContain("MODEL_REGISTRY.filter");
  });

  it("подключение даёт право выбрать, но не право потратить", () => {
    // Ворота оплаты (сторонние модели, Gateway, свежий тариф, бюджет)
    // остаются в policyModelCall и о ручных моделях не знают.
    const call = policy.slice(policy.indexOf("export async function policyModelCall"));
    expect(call).toContain("allowThirdParty");
    expect(call, "ручное подключение не должно обходить проверку тарифа")
      .not.toContain("custom");
  });

  it("управление моделями — только под админским шлюзом", () => {
    expect(idx).toContain('url.pathname === "/api/admin/models"');
    const gate = readFileSync("src/lib/accounts.ts", "utf8");
    expect(gate).toMatch(/\/api\/admin\//);
  });

  it("выпадающее меню строится из расширенного реестра и помечает ручные", () => {
    expect(idx).toContain("(await effectiveRegistry(env)).map");
    expect(idx).toContain("custom: !findModel(m.slug)");
    const js = script();
    expect(js, "ручная модель не должна выглядеть как проверенная").toContain("m.custom ? 'вручную · '");
  });

  it("форма подключения не подставляет текст с сервера через innerHTML", () => {
    const js = script();
    const block = js.slice(js.indexOf("function loadCustomModels"), js.indexOf("$('cmAdd').addEventListener"));
    expect(block).not.toContain("innerHTML");
    expect(block, "список должен строиться теми же помощниками, что остальные модули").toContain("modItem(");
  });

  it("форма скрыта у наблюдателя, а не показана и отклонена сервером", () => {
    const js = script();
    expect(js).toMatch(/customCard'\)\.classList\.toggle\('hidden', myRole !== 'admin'\)/);
  });

  it("таблица есть и в миграции, и в схеме свежей установки", () => {
    // schema.sql миграции не проигрывает: пропуск здесь означал бы
    // таблицу, которой на новой базе не будет никогда.
    expect(readFileSync("migrations/008-custom-models.sql", "utf8")).toContain("CREATE TABLE IF NOT EXISTS custom_models");
    expect(readFileSync("schema.sql", "utf8")).toContain("CREATE TABLE IF NOT EXISTS custom_models");
    const mig = readFileSync("scripts/migrate.mjs", "utf8");
    expect(mig).toContain("008-custom-models.sql");
    expect(mig, "таблица должна попасть в проверку после миграции").toContain("'custom_models'");
  });
});
