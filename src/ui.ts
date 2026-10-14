import { Markup } from "telegraf";
import { differenceInCalendarDays, parseISO } from "date-fns";
import type {
  HouseholdStore,
  HistoryEvent,
  RecurringTask,
  ShoppingItem,
  View,
} from "./storage";
import {
  dueThisWeek,
  getNextDate,
  intervalLabel,
  scheduleProblem,
} from "./tasks";

const PAGE_SIZE = 6;
const button = (text: string, data: string) =>
  Markup.button.callback(text, data);
type Button = ReturnType<typeof button>;
// Bot API 9.4 supports button styles; Telegraf's bundled types predate that field.
const control = (
  text: string,
  data: string,
): Button & { style: "primary" } => ({
  ...button(text, data),
  style: "primary",
});
const canUndo = (
  event: HistoryEvent | undefined,
  revision: number | undefined,
): event is HistoryEvent =>
  !!event &&
  !event.undone &&
  event.action !== "undo" &&
  event.after_revision === revision;
export interface Screen {
  text: string;
  keyboard: ReturnType<typeof Markup.inlineKeyboard>;
}

export const homeKeyboard = Markup.keyboard([
  ["🛒 Ostoslista", "📅 Viikon hommat"],
  ["➕ Ostoksia", "➕ Uusi homma"],
  ["📋 Kaikki hommat", "ℹ️ Ohje"],
]).resize();

export const displayDate = (date: string): string =>
  `${Number(date.slice(8, 10))}.${Number(date.slice(5, 7))}.${date.slice(0, 4)}`;

const short = (name: string) =>
  name.length > 44 ? `${name.slice(0, 43)}…` : name;
export const displayName = (name: string, limit = 500) =>
  name.length > limit ? `${name.slice(0, limit - 1)}… (lyhennetty)` : name;

export const dueLabel = (task: RecurringTask, date: string): string => {
  if (task.archived_at) return "arkistoitu";
  if (scheduleProblem(task)) return "⚠️ korjaa aikataulu";
  const due = getNextDate(task);
  if (task.snoozed_until && task.snoozed_until > date) {
    return `muistutus ${displayDate(task.snoozed_until)}`;
  }
  if (due < date) {
    const days = differenceInCalendarDays(parseISO(date), parseISO(due));
    return `${days} pv myöhässä`;
  }
  return due === date ? "tänään" : displayDate(due);
};

const actions: Record<string, string> = {
  added: "lisätty",
  buy: "merkitty ostetuksi",
  restore: "palautettu",
  remove: "poistettu",
  rename: "nimetty uudelleen",
  done: "merkitty tehdyksi",
  snooze: "muistutusta siirretty",
  archive: "arkistoitu",
  edit: "muokattu",
  undo: "merkintä kumottu",
};

const paginate = <T>(values: T[], requested: number) => {
  const pages = Math.max(1, Math.ceil(values.length / PAGE_SIZE));
  const page = Math.max(0, Math.min(requested, pages - 1));
  return {
    values: values.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    page,
    pages,
  };
};

const pager = (
  page: number,
  pages: number,
  callback: (page: number) => string,
): Button[][] =>
  pages > 1
    ? [
        [
          control("‹", callback(Math.max(0, page - 1))),
          control(`${page + 1}/${pages}`, callback(page)),
          control("›", callback(Math.min(pages - 1, page + 1))),
        ],
      ]
    : [];

export const renderView = (
  store: HouseholdStore,
  view: View,
  date: string,
): Screen => {
  let text: string;
  const rows: Button[][] = [];
  if (view.kind === "shopping") {
    const items = store.items(view.tab);
    const { values, page, pages } = paginate(items, view.page);
    const titles = {
      active: "🛒 Ostoslista",
      bought: "✅ Ostetut",
      removed: "🗑️ Poistetut",
    };
    text = `${titles[view.tab]} · ${items.length} tuotetta`;
    if (!items.length) {
      text +=
        view.tab === "active"
          ? "\nLista on tyhjä. Lisää tuotteita alla olevasta painikkeesta."
          : "\nEi tuotteita tässä näkymässä.";
    } else {
      text += view.edit
        ? "\nValitse tuote muokattavaksi."
        : view.tab === "active"
          ? "\nNapauta tuotetta merkitäksesi sen ostetuksi."
          : "\nNapauta tuotetta palauttaaksesi sen.";
      if (values.some((item) => item.item.length > 44)) {
        text += "\nPitkät nimet avautuvat ensin tarkistettaviksi.";
      }
    }
    for (const item of values) {
      const prefix = view.edit
        ? "✏️"
        : view.tab === "active"
          ? "☐"
          : view.tab === "bought"
            ? "✅"
            : "🗑️";
      rows.push([
        button(
          `${prefix} ${short(item.item)}`,
          view.edit || item.item.length > 44
            ? `item:${item.id}`
            : `si:${view.tab === "active" ? "buy" : "restore"}:${item.id}:${item.revision}`,
        ),
      ]);
    }
    rows.push(
      ...pager(page, pages, (p) => `sh:${view.tab}:${p}:${Number(view.edit)}`),
    );
    rows.push([
      control("➕ Lisää tuotteita", "capture"),
      control("↻ Päivitä", `sh:${view.tab}:${page}:${Number(view.edit)}`),
    ]);
    rows.push([
      control(`Ostamatta (${store.items("active").length})`, "sh:active:0:0"),
      control(`Ostetut (${store.items("bought").length})`, "sh:bought:0:0"),
      control(`Poistetut (${store.items("removed").length})`, "sh:removed:0:0"),
    ]);
    const footer = [
      control(
        view.edit ? "↩️ Takaisin" : "⚙️ Muokkaa",
        `sh:${view.tab}:${page}:${Number(!view.edit)}`,
      ),
    ];
    const latest = store.latestEvent("shopping");
    const changedItem = latest ? store.item(latest.entity_id) : undefined;
    if (canUndo(latest, changedItem?.revision) && changedItem) {
      footer.push(
        control(`↩️ Kumoa: ${short(changedItem.item)}`, `undo:${latest.id}`),
      );
    }
    rows.push(footer);
  } else if (view.kind === "tasks") {
    let tasks = store
      .tasks(true)
      .filter((task) =>
        view.tab === "archived"
          ? !!task.archived_at
          : view.tab === "all"
            ? !task.archived_at
            : dueThisWeek(task, date),
      );
    tasks = tasks.sort(
      (a, b) =>
        (scheduleProblem(a) ? "" : getNextDate(a)).localeCompare(
          scheduleProblem(b) ? "" : getNextDate(b),
        ) || a.id - b.id,
    );
    const { values, page, pages } = paginate(tasks, view.page);
    text =
      view.tab === "due"
        ? "📋 Tämän viikon ja myöhässä olevat hommat"
        : view.tab === "all"
          ? "📋 Kaikki hommat"
          : "📦 Arkistoidut hommat";
    text += ` · ${tasks.length}`;
    if (!tasks.length) {
      text +=
        view.tab === "due"
          ? "\nEi muistutettavia hommia tälle viikolle. 🎉"
          : "\nEi hommia tässä näkymässä.";
    }
    text += "\nValitse homma nähdäksesi tiedot ja toiminnot.";
    for (const task of values) {
      rows.push([
        button(
          `${short(task.name)} · ${dueLabel(task, date)}`,
          `task:${task.id}`,
        ),
      ]);
    }
    rows.push(...pager(page, pages, (p) => `tl:${view.tab}:${p}`));
    rows.push([control("➕ Uusi homma", "newtask")]);
    rows.push([
      control("Viikon hommat", "tl:due:0"),
      control("Kaikki", "tl:all:0"),
      control("Arkisto", "tl:archived:0"),
    ]);
    rows.push([control("Päivitä", `tl:${view.tab}:${page}`)]);
  } else if (view.kind === "item") {
    const item = store.item(view.id);
    if (!item) return missing("Tuotetta ei löydy.", "sh:active:0:0");
    const status: Record<ShoppingItem["status"], string> = {
      active: "ostamatta",
      bought: "ostettu",
      removed: "poistettu",
    };
    text = `${displayName(item.item)}\nTila: ${status[item.status]}`;
    if (item.status === "active") {
      rows.push([control("✅ Ostettu", `si:buy:${item.id}:${item.revision}`)]);
    } else {
      rows.push([
        control("↩️ Palauta", `si:restore:${item.id}:${item.revision}`),
      ]);
    }
    rows.push([
      control("Nimeä uudelleen", `rename:${item.id}:${item.revision}`),
    ]);
    if (item.status !== "removed") {
      rows.push([
        control(
          "Poista (palautettavissa)",
          `si:remove:${item.id}:${item.revision}`,
        ),
      ]);
    }
    rows.push([
      control("Historia", `hi:shopping:${item.id}:0`),
      control("Takaisin", `sh:${item.status}:0:0`),
    ]);
    const latest = store.latestEvent("shopping", item.id);
    if (canUndo(latest, item.revision)) {
      rows.push([control("↩️ Kumoa viimeisin muutos", `undo:${latest.id}`)]);
    }
  } else if (view.kind === "task") {
    const task = store.task(view.id);
    if (!task) return missing("Hommaa ei löydy.", "tl:due:0");
    const problem = scheduleProblem(task);
    text = problem
      ? `${displayName(task.name)}\n⚠️ Aikataulu tarvitsee korjauksen: ${problem}\n` +
        `Tallennettu toisto: ${displayName(task.interval)}\nTallennettu valmistuminen: ${displayName(task.last_done ?? "ei kirjattu")}\n` +
        "Alkuperäiset tiedot on säilytetty. Muokkaa toistoa ja tarvittaessa aseta uusi eräpäivä."
      : `${displayName(task.name)}\nToistuu: ${intervalLabel(task.interval)} valmistumisesta\n` +
        `Viimeksi tehty: ${task.last_done ? displayDate(task.last_done) : "ei kirjattu"}\n` +
        `Seuraava: ${displayDate(getNextDate(task))} · ${dueLabel(task, date)}`;
    if (task.snoozed_until) {
      text += `\nMuistutusta siirretty: ${displayDate(task.snoozed_until)} (eräpäivä ennallaan)`;
    }
    if (task.archived_at) {
      rows.push([
        control("Palauta homma", `ta:restore:${task.id}:${task.revision}`),
      ]);
    } else {
      if (!problem && task.last_done !== date) {
        const buttons = [
          control("✅ Tehty tänään", `ta:done:${task.id}:${task.revision}`),
        ];
        if (dueThisWeek(task, date)) {
          buttons.push(
            control(
              "💤 Siirrä muistutusta",
              `snooze:${task.id}:${task.revision}`,
            ),
          );
        }
        rows.push(buttons);
      } else if (!problem) {
        text += "\n✅ Tehty tänään";
      }
      rows.push([
        control("Muokkaa", `edit:${task.id}:${task.revision}`),
        control("Arkistoi", `archive:${task.id}:${task.revision}`),
      ]);
    }
    const latest = store.latestEvent("task", task.id);
    if (canUndo(latest, task.revision)) {
      rows.push([control("Kumoa viimeisin merkintä", `undo:${latest.id}`)]);
    }
    rows.push([
      control("Historia", `hi:task:${task.id}:0`),
      control("Takaisin hommiin", "tl:due:0"),
    ]);
  } else {
    const entity =
      view.entity === "task" ? store.task(view.id) : store.item(view.id);
    if (!entity)
      return missing(
        "Kohdetta ei löydy.",
        view.entity === "task" ? "tl:due:0" : "sh:active:0:0",
      );
    const events = store.history(view.entity, view.id);
    const { values, page, pages } = paginate(events, view.page);
    text = `🕓 ${displayName(view.entity === "task" ? (entity as RecurringTask).name : (entity as ShoppingItem).item)}\nHistoria`;
    if (!events.length)
      text +=
        "\nEi merkintöjä. Vanhan tietokannan historiaa ei ole saatavilla.";
    for (const event of values) {
      const before = event.before_json
        ? (JSON.parse(event.before_json) as Partial<
            RecurringTask & ShoppingItem
          >)
        : null;
      text +=
        `\n\n#${event.id} · ${actions[event.action] ?? event.action}${event.undone ? " (kumottu)" : ""}` +
        `\n${event.actor_name} · ${event.created_at} UTC`;
      if (event.action === "edit" && before) {
        text += `\nEnnen: ${displayName(before.name ?? "", 160)} · ${displayName(before.interval ?? "", 64)} · viimeksi ${displayName(before.last_done ?? "ei kirjattu", 32)}`;
      }
      if (event.action === "rename" && before)
        text += `\nEnnen: ${displayName(before.item ?? "", 160)}`;
      if (event.action === "done" && before)
        text += `\nEdellinen valmistuminen: ${displayName(before.last_done ?? "ei kirjattu", 32)}`;
      if (canUndo(event, entity.revision)) {
        rows.push([control(`Kumoa #${event.id}`, `undo:${event.id}`)]);
      }
    }
    rows.push(
      ...pager(page, pages, (p) => `hi:${view.entity}:${view.id}:${p}`),
    );
    rows.push([
      control(
        "Takaisin",
        `${view.entity === "task" ? "task" : "item"}:${view.id}`,
      ),
    ]);
  }
  return { text, keyboard: Markup.inlineKeyboard(rows) };
};

const missing = (text: string, callback: string): Screen => ({
  text,
  keyboard: Markup.inlineKeyboard([[control("Takaisin", callback)]]),
});
