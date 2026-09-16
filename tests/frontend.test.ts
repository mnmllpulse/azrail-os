import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * ПЕРВЫЕ ТЕСТЫ НА ИНТЕРФЕЙС.
 *
 * До этого файла все 575 тестов проверяли бэкенд. Меню на телефоне не
 * открывалось: в блоке `@media (max-width: 650px)` стояло
 * `.sidebar { display: none }`, и оно перебивало блок 860px, где панель
 * настроена как выезжающая. Кнопка честно переключала класс, двигать было
 * нечего. Поймать это не мог ни один тест, потому что проверять интерфейс
 * было нечем вовсе.
 *
 * ЧЕСТНО О ГРАНИЦАХ: это статический разбор файла, а не браузер. Здесь
 * ловится класс «правило само себя перебило» и «обработчик отвалился от
 * разметки» — то есть ровно тот класс, что уже случился. Реальную отрисовку
 * это не заменяет и не притворяется, что заменяет.
 */

const html = readFileSync(resolve(__dirname, "..", "public/index.html"), "utf-8");

const styles = (): string => {
  const out: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) out.push(m[1]);
  // Комментарии убираются до разбора: правило, стоящее сразу после
  // блочного комментария, иначе не опознаётся как начало нового
  // объявления — и проверка молча смотрит не на те строки.
  return out.join("\n").replace(/\/\*[\s\S]*?\*\//g, "\n");
};

const script = (): string => {
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
  return m ? m[1] : "";
};

interface Block {
  /** Условие media-запроса; пустая строка — правила верхнего уровня. */
  condition: string;
  body: string;
  /** Порядок в файле: при равной специфичности побеждает последний. */
  order: number;
}

/** Разбор CSS на блоки верхнего уровня и media-блоки, с сохранением порядка. */
function blocks(css: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  let plain = "";
  let order = 0;

  while (i < css.length) {
    const at = css.indexOf("@media", i);
    if (at === -1) {
      plain += css.slice(i);
      break;
    }
    plain += css.slice(i, at);

    const open = css.indexOf("{", at);
    const condition = css.slice(at + 6, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
      j++;
    }
    out.push({ condition, body: css.slice(open + 1, j - 1), order: order++ });
    i = j;
  }
  out.unshift({ condition: "", body: plain, order: -1 });
  return out;
}

/** Применим ли media-блок при данной ширине окна. */
function appliesAt(condition: string, width: number): boolean {
  if (!condition) return true;
  // Учитываются только ширины: остальные условия (печать, тёмная тема,
  // reduced-motion) к этому вопросу отношения не имеют.
  if (/prefers-|print|hover|orientation/.test(condition)) return false;
  const max = /max-width:\s*(\d+)px/.exec(condition);
  const min = /min-width:\s*(\d+)px/.exec(condition);
  if (max && width > Number(max[1])) return false;
  if (min && width < Number(min[1])) return false;
  return !!(max || min);
}

/** Объявления для селектора, в порядке файла. */
function declarationsFor(selector: string, width: number): string[] {
  const found: string[] = [];
  for (const b of blocks(styles())) {
    if (!appliesAt(b.condition, width)) continue;
    const re = new RegExp(`(^|[,}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(,[^{]*)?\\{([^}]*)\\}`, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(b.body))) found.push(m[3]);
  }
  return found;
}

const PHONE = 380; // типичная ширина телефона, на которой и сломалось

describe("Боковое меню на телефоне", () => {
  it("панель НЕ удаляется из документа на узком экране", () => {
    // Собственно тот баг. `display: none` в блоке 650px перебивал блок
    // 860px, где панель — выезжающая, и кнопка переставала работать.
    const decls = declarationsFor(".sidebar", PHONE);
    expect(decls.length, "правила .sidebar не найдены — разбор CSS сломался").toBeGreaterThan(0);
    for (const d of decls) {
      expect(d, `на ширине ${PHONE}px панель гасится через display:none`).not.toMatch(/display\s*:\s*none/);
    }
  });

  it("панель на телефоне лежит поверх и убирается сдвигом", () => {
    const decls = declarationsFor(".sidebar", PHONE).join(";");
    expect(decls).toMatch(/position\s*:\s*fixed/);
    const closed = declarationsFor(".layout.nav-closed .sidebar", PHONE).join(";");
    expect(closed).toMatch(/transform\s*:\s*translateX\(-100%\)/);
  });

  it("правила узкой рейки не протекают на телефон", () => {
    // Блок 1050px задаёт панели вид узкой полосы (сжатые отступы, скрытые
    // подписи). Ниже 861px панель — уже не рейка, а выезжающее меню, и эти
    // правила там только сплющивают его.
    const railBlock = blocks(styles()).find(
      (b) => /max-width:\s*1050px/.test(b.condition) && /\.nav-item span/.test(b.body),
    );
    expect(railBlock, "блок с правилами рейки не найден").toBeTruthy();
    expect(railBlock!.condition, "рейка обязана быть ограничена снизу").toMatch(/min-width:\s*861px/);
  });

  it("кнопка меню связана с разметкой и доступна", () => {
    expect(html).toContain('id="menuBtn"');
    expect(html).toContain('aria-expanded');
    const js = script();
    expect(js).toContain("$('menuBtn').addEventListener('click'");
    // Состояние объявляется вспомогательным технологиям, а не только
    // красится: aria-expanded должен меняться в обе стороны.
    expect(js).toMatch(/aria-expanded['"],\s*['"]true/);
    expect(js).toMatch(/aria-expanded['"],\s*['"]false/);
  });

  it("фон не прокручивается под открытым меню", () => {
    const js = script();
    expect(js).toContain("document.body.style.overflow = 'hidden'");
    expect(js).toContain("document.body.style.overflow = ''");
  });

  it("затемнение перекрывает страницу и закрывает меню по нажатию", () => {
    const veil = declarationsFor(".nav-veil", PHONE).join(";");
    expect(veil).toMatch(/position\s*:\s*fixed/);
    expect(script()).toContain("navVeil.addEventListener('click', closeNav)");
  });
});

describe("Интерфейс умеет ждать фоновую миссию", () => {
  const js = script();

  it("ответ 202 не принимается за результат", () => {
    // POST больше не возвращает выполненную работу — только идентификатор.
    // Без этой ветки экран показал бы пустой результат сразу после запуска.
    expect(js).toContain("data.status === 'accepted'");
    expect(js).toContain("pollMission()");
  });

  it("опрос не бьётся вечно и не сдаётся от одного разрыва", () => {
    expect(js).toContain("/api/mission?missionId=");
    // Разрыв связи — не повод считать миссию упавшей: она идёт на сервере
    // независимо от того, смотрит ли кто-то.
    expect(js).toMatch(/pollTimer = setTimeout\(tick/);
    // И при этом опрос обязан когда-то закончиться сам.
    expect(js).toMatch(/deadAt/);
  });

  it("«Отменить» действительно останавливает миссию на сервере", () => {
    // Раньше кнопка рвала HTTP-соединение — а цикл шёл внутри него, так что
    // это работало. Теперь цикл в фоне и об оборванном сокете не знает:
    // без явной команды он продолжал бы жечь модели до потолка шагов.
    expect(js).toContain("/api/mission/cancel");
    expect(js).toContain("stopPolling()");
  });

  it("отмена не выдаётся за поломку", () => {
    expect(js).toContain("mission.cancelled");
  });
});
