import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { HouseholdStore, type Mutation } from "../src/storage";
import { InputError } from "../src/errors";
import {
  addInterval,
  dueThisWeek,
  getNextDate,
  parseInterval,
  today,
  validDate,
  weeklyRunKey,
} from "../src/tasks";
import { renderView } from "../src/ui";

const actor = { id: 10, name: "Jan" };
const spouse = { id: 20, name: "Spouse" };
const changed = (result: Mutation): number => {
  assert.equal(result.kind, "changed");
  if (result.kind !== "changed") throw new Error("Expected changed result");
  return result.eventId;
};

const legacy = (file: string) => {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE active_chats (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE permitted_users (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE shopping_list (
      id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL,
      added_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) STRICT;
    CREATE TABLE recurring_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      interval TEXT NOT NULL, last_done TEXT
    ) STRICT;
    INSERT INTO active_chats VALUES (-123);
    INSERT INTO permitted_users VALUES (10), (20);
    INSERT INTO shopping_list VALUES (7, 'Maito 2 l', 10, '2026-10-01 11:00:00');
    INSERT INTO shopping_list VALUES (12, 'Kahvi', 20, '2026-10-02 12:00:00');
    INSERT INTO recurring_tasks VALUES (3, 'Imurointi', '2vk', '2026-09-27');
    INSERT INTO recurring_tasks VALUES (9, 'Suodatin', '1kk', NULL);
  `);
  db.close();
};

test("legacy migration preserves all existing data, IDs, subscriptions and permissions; reopening is idempotent", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hommabot-migration-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, "household.db");
  legacy(file);
  let store = new HouseholdStore(file, "2026-10-13");
  assert.equal(store.db.pragma("user_version", { simple: true }), 1);
  assert.deepEqual(store.activeChats(), [-123]);
  assert.deepEqual(store.permittedUsers(), [10, 20]);
  assert.deepEqual(
    store.items().map((item) => ({
      id: item.id,
      item: item.item,
      added_by: item.added_by,
      created_at: item.created_at,
      status: item.status,
    })),
    [
      {
        id: 7,
        item: "Maito 2 l",
        added_by: 10,
        created_at: "2026-10-01 11:00:00",
        status: "active",
      },
      {
        id: 12,
        item: "Kahvi",
        added_by: 20,
        created_at: "2026-10-02 12:00:00",
        status: "active",
      },
    ],
  );
  assert.equal(store.task(3)?.last_done, "2026-09-27");
  assert.equal(store.task(3)?.interval, "2vk");
  assert.equal(getNextDate(store.task(3)!), "2026-10-11");
  assert.equal(store.task(9)?.last_done, null);
  assert.equal(getNextDate(store.task(9)!), "2026-10-13");
  assert.equal(store.history("task", 3).length, 0);
  changed(store.changeItem(7, 0, "buy", actor));
  store.close();
  store = new HouseholdStore(file, "2026-10-20");
  t.after(() => store.close());
  assert.equal(store.item(7)?.status, "bought");
  assert.equal(store.task(9)?.first_due, "2026-10-13");
  assert.equal(store.items().length, 2);
  assert.equal(store.addItems(["Omenat"], actor).added[0].id, 13);
  assert.equal(store.addTask("Pyykki", "1vk", "2026-10-13", actor), 10);
});

test("failed migration rolls back schema, data and version rather than partly upgrading", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hommabot-rollback-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, "legacy.db");
  legacy(file);
  const old = new Database(file);
  old.exec("CREATE TABLE history (legacy_note TEXT) STRICT");
  old.close();
  assert.throws(
    () => new HouseholdStore(file, "2026-10-13"),
    /table history already exists/,
  );
  const db = new Database(file);
  t.after(() => db.close());
  assert.equal(db.pragma("user_version", { simple: true }), 0);
  const columns = db.prepare("PRAGMA table_info(shopping_list)").all() as {
    name: string;
  }[];
  assert.ok(!columns.some((column) => column.name === "status"));
  assert.equal(
    (
      db.prepare("SELECT COUNT(*) AS n FROM shopping_list").get() as {
        n: number;
      }
    ).n,
    2,
  );
  assert.deepEqual(
    db
      .prepare("PRAGMA table_info(history)")
      .all()
      .map((column) => (column as { name: string }).name),
    ["legacy_note"],
  );
});

test("unsupported legacy schedules migrate without losing data and can be repaired through editing", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hommabot-legacy-input-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, "legacy.db");
  legacy(file);
  const old = new Database(file);
  old.prepare("UPDATE recurring_tasks SET interval = '0pv' WHERE id = 3").run();
  old
    .prepare("UPDATE recurring_tasks SET last_done = 'not-a-date' WHERE id = 9")
    .run();
  old.close();
  const warnings = t.mock.method(console, "warn", () => {});
  const store = new HouseholdStore(file, "2026-10-13");
  t.after(() => store.close());
  assert.equal(warnings.mock.callCount(), 2);
  assert.equal(store.task(3)?.interval, "0pv");
  assert.equal(store.task(9)?.last_done, "not-a-date");
  assert.equal(store.items().length, 2);
  const screen = renderView(
    store,
    { kind: "tasks", tab: "due", page: 0 },
    "2026-10-13",
  );
  assert.ok(
    screen.keyboard.reply_markup.inline_keyboard.some((row) =>
      row.some((button) => button.text.includes("korjaa aikataulu")),
    ),
  );
  assert.ok(
    renderView(store, { kind: "task", id: 3 }, "2026-10-13").text.includes(
      "tiedot on säilytetty",
    ),
  );
  const repaired = changed(
    store.changeTask(3, 0, "edit", actor, "2026-10-13", {
      name: "Imurointi",
      interval: "1vk",
    }),
  );
  assert.equal(store.task(3)?.last_done, "2026-09-27");
  assert.equal(getNextDate(store.task(3)!), "2026-10-04");
  changed(store.undo(repaired, actor));
  assert.equal(store.task(3)?.interval, "0pv");
  store.changeTask(3, 2, "archive", actor, "2026-10-13");
  store.changeTask(3, 3, "restore", actor, "2026-10-13");
  assert.equal(store.task(3)?.archived_at, null);
  changed(
    store.changeTask(9, 0, "edit", actor, "2026-10-13", {
      name: "Suodatin",
      interval: "1kk",
      firstDue: "2026-10-20",
    }),
  );
  assert.equal(getNextDate(store.task(9)!), "2026-10-20");
  assert.equal(
    JSON.parse(store.history("task", 9)[0].before_json!).last_done,
    "not-a-date",
  );
});

test("future database versions are refused without modifying their schema or data", (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "hommabot-future-schema-"),
  );
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, "future.db");
  const future = new Database(file);
  future.exec(
    "CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('keep'); PRAGMA user_version = 2;",
  );
  future.close();
  assert.throws(
    () => new HouseholdStore(file, "2026-10-13"),
    /Unsupported database version: 2/,
  );
  const db = new Database(file);
  t.after(() => db.close());
  assert.equal(db.pragma("user_version", { simple: true }), 2);
  assert.deepEqual(db.prepare("SELECT value FROM future_data").all(), [
    { value: "keep" },
  ]);
  assert.equal(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name = 'shopping_list'")
      .get(),
    undefined,
  );
});

test("shopping buy, removal, restoration and undo preserve data and prior state", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const item = store.addItems(["Maito"], actor).added[0];
  const bought = changed(store.changeItem(item.id, 0, "buy", spouse));
  assert.equal(store.item(item.id)?.status, "bought");
  assert.equal(store.changeItem(item.id, 0, "buy", actor).kind, "stale");
  const removed = changed(store.changeItem(item.id, 1, "remove", actor));
  assert.equal(store.items("removed").length, 1);
  assert.equal(store.item(item.id)?.previous_status, "bought");
  changed(store.undo(removed, spouse));
  assert.equal(store.item(item.id)?.status, "bought");
  assert.equal(store.undo(bought, actor).kind, "stale");
  changed(store.changeItem(item.id, 3, "restore", actor));
  assert.equal(store.item(item.id)?.status, "active");
  const removedActive = changed(store.changeItem(item.id, 4, "remove", actor));
  changed(store.changeItem(item.id, 5, "restore", actor));
  assert.equal(store.item(item.id)?.status, "active");
  assert.equal(store.undo(removedActive, actor).kind, "stale");
  assert.equal(store.items().length, 1);
  assert.equal(store.history("shopping", item.id)[0].actor_name, "Jan");
});

test("shopping batch input is atomic and duplicate additions require explicit opt-in", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const batch = store.addItems(["Maito 2 l", "Kahvi", "kahvi"], actor);
  assert.equal(batch.added.length, 2);
  assert.deepEqual(batch.duplicates, ["kahvi"]);
  assert.equal(store.addItems(["Kahvi"], spouse, true).added.length, 1);
  assert.throws(() => store.addItems(["Omenat", ""], actor), InputError);
  assert.equal(store.items().length, 3);
  const event = batch.eventIds[0];
  changed(store.undo(event, actor));
  assert.equal(store.item(batch.added[0].id)?.status, "removed");
  assert.equal(store.undo(event, actor).kind, "stale");
  assert.equal(
    store.undo(store.history("shopping", batch.added[0].id)[0].id, actor).kind,
    "stale",
  );
});

test("task completion and undo restore the exact previous schedule; stale taps cannot advance it", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const id = store.addTask("Imurointi", "2vk", "2026-10-11", actor);
  const event = changed(store.changeTask(id, 0, "done", spouse, "2026-10-13"));
  assert.equal(store.task(id)?.last_done, "2026-10-13");
  assert.equal(getNextDate(store.task(id)!), "2026-10-27");
  assert.equal(
    store.changeTask(id, 0, "done", actor, "2026-10-14").kind,
    "stale",
  );
  assert.equal(
    store.changeTask(id, 1, "done", actor, "2026-10-13").kind,
    "unchanged",
  );
  changed(store.undo(event, actor));
  assert.equal(store.task(id)?.last_done, null);
  assert.equal(getNextDate(store.task(id)!), "2026-10-11");
  assert.equal(store.undo(event, actor).kind, "stale");
  store.changeTask(id, 2, "done", actor, "2026-10-13");
  const next = changed(store.changeTask(id, 3, "done", actor, "2026-10-28"));
  changed(store.undo(next, spouse));
  assert.equal(store.task(id)?.last_done, "2026-10-13");
  assert.equal(getNextDate(store.task(id)!), "2026-10-27");
});

test("snooze, archive, edit and restore have distinct semantics and reversible history", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const id = store.addTask("Suodatin", "1kk", "2026-10-01", actor);
  store.changeTask(id, 0, "snooze", actor, "2026-10-16");
  assert.equal(getNextDate(store.task(id)!), "2026-10-01");
  assert.equal(dueThisWeek(store.task(id)!, "2026-10-13"), true);
  assert.equal(dueThisWeek(store.task(id)!, "2026-10-16"), true);
  const archived = changed(
    store.changeTask(id, 1, "archive", actor, "2026-10-13"),
  );
  assert.equal(store.tasks().length, 0);
  assert.equal(
    store.changeTask(id, 2, "done", actor, "2026-10-13").kind,
    "unchanged",
  );
  changed(store.undo(archived, actor));
  store.changeTask(id, 3, "done", actor, "2026-10-13");
  const edited = changed(
    store.changeTask(id, 4, "edit", actor, "2026-10-13", {
      name: "Uusi suodatin",
      interval: "2kk",
      firstDue: "2026-10-20",
    }),
  );
  assert.equal(store.task(id)?.last_done, null);
  assert.equal(getNextDate(store.task(id)!), "2026-10-20");
  changed(store.undo(edited, actor));
  assert.equal(store.task(id)?.last_done, "2026-10-13");
  assert.equal(store.task(id)?.name, "Suodatin");
  const archivedAgain = changed(
    store.changeTask(id, 6, "archive", actor, "2026-10-13"),
  );
  store.changeTask(id, 7, "restore", spouse, "2026-10-13");
  assert.equal(store.tasks().length, 1);
  assert.equal(store.undo(archivedAgain, actor).kind, "stale");
});

test("sessions, tracked views and delivery state survive reopening", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hommabot-session-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const file = path.join(directory, "state.db");
  let store = new HouseholdStore(file, "2026-10-13");
  store.setSession(-123, 10, {
    state: { kind: "shopping-add" },
    promptId: 77,
    expiresAt: 10000,
  });
  store.trackView(-123, 50, {
    kind: "shopping",
    tab: "active",
    page: 0,
    edit: false,
  });
  store.recordReminder("2026-10-12", -123);
  store.recordSnoozeReminder(7, 3, -123);
  store.close();
  store = new HouseholdStore(file, "2026-10-14");
  t.after(() => store.close());
  assert.equal(store.session(-123, 10)?.promptId, 77);
  assert.equal(store.session(-123, 20), undefined);
  assert.equal(store.views()[0].messageId, 50);
  assert.equal(store.reminderSent("2026-10-12", -123), true);
  assert.equal(store.snoozeReminderSent(7, 3, -123), true);
  store.clearSession(-123, 10);
  assert.equal(store.session(-123, 10), undefined);
  for (let id = 51; id <= 59; id++)
    store.trackView(-123, id, { kind: "task", id: 1 });
  assert.equal(store.views().length, 6);
});

test("calendar intervals, local dates and week boundaries are correct", () => {
  assert.equal(addInterval("2026-01-31", "1kk"), "2026-02-28");
  assert.equal(addInterval("2024-02-29", "1v"), "2025-02-28");
  assert.equal(addInterval("2026-10-13", "2vk"), "2026-10-27");
  for (const interval of ["0pv", "-1vk", "1.5kk", "1001v", "pv"]) {
    assert.throws(() => parseInterval(interval), InputError);
  }
  assert.equal(validDate("2026-02-30"), false);
  assert.equal(
    today("Europe/Helsinki", new Date("2026-10-12T22:30:00Z")),
    "2026-10-13",
  );
  assert.equal(
    weeklyRunKey(new Date("2026-10-12T05:59:00Z"), "Europe/Helsinki"),
    null,
  );
  assert.equal(
    weeklyRunKey(new Date("2026-10-12T06:00:00Z"), "Europe/Helsinki"),
    "2026-10-12",
  );
  assert.equal(
    weeklyRunKey(new Date("2026-10-14T06:00:00Z"), "Europe/Helsinki"),
    "2026-10-12",
  );
});

test("overdue tasks remain due, next Monday is excluded and screens are named and paginated", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const overdue = store.addTask(
    "Vanha *homma* [nimi]",
    "1vk",
    "2026-09-01",
    actor,
  );
  const boundary = store.addTask("Ensi maanantai", "1vk", "2026-10-19", actor);
  assert.equal(dueThisWeek(store.task(overdue)!, "2026-10-13"), true);
  assert.equal(dueThisWeek(store.task(boundary)!, "2026-10-13"), false);
  for (let i = 0; i < 7; i++)
    store.addTask(`Homma ${i}`, "1vk", "2026-10-13", actor);
  const screen = renderView(
    store,
    { kind: "tasks", tab: "due", page: 0 },
    "2026-10-13",
  );
  const taskButtons = screen.keyboard.reply_markup.inline_keyboard
    .flat()
    .filter(
      (button) =>
        "callback_data" in button && button.callback_data.startsWith("task:"),
    );
  assert.equal(taskButtons.length, 6);
  assert.ok(taskButtons[0].text.includes("Vanha *homma* [nimi]"));
  assert.ok(taskButtons.every((button) => button.text !== "✅"));
  assert.ok(!("parse_mode" in screen.keyboard));
  const card = renderView(store, { kind: "task", id: overdue }, "2026-10-13");
  assert.ok(card.text.includes("Vanha *homma* [nimi]"));
  assert.ok(card.text.includes("viikon välein valmistumisesta"));
  assert.equal(
    store.changeTask(999, 0, "done", actor, "2026-10-13").kind,
    "missing",
  );
});

test("screens fit Telegram limits and long shopping names open details before mutation", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const item = store.addItems(["x".repeat(200)], actor).added[0];
  const shopping = renderView(
    store,
    { kind: "shopping", tab: "active", page: 0, edit: false },
    "2026-10-13",
  );
  const first = shopping.keyboard.reply_markup.inline_keyboard[0][0];
  assert.ok(
    "callback_data" in first && first.callback_data === `item:${item.id}`,
  );
  const id = store.addTask("n".repeat(200), "1vk", "2026-10-13", actor);
  for (let revision = 0; revision < 8; revision++) {
    store.changeTask(
      id,
      revision,
      "edit",
      { id: 20, name: "a".repeat(128) },
      "2026-10-13",
      {
        name: `${revision}${"n".repeat(199)}`,
        interval: "1kk",
      },
    );
  }
  const screens = [
    shopping,
    renderView(store, { kind: "item", id: item.id }, "2026-10-13"),
    renderView(store, { kind: "task", id }, "2026-10-13"),
    renderView(
      store,
      { kind: "history", entity: "task", id, page: 0 },
      "2026-10-13",
    ),
    renderView(
      store,
      { kind: "history", entity: "task", id, page: 1 },
      "2026-10-13",
    ),
  ];
  for (const screen of screens) {
    assert.ok(
      screen.text.length <= 4096,
      `Screen exceeds Telegram's text limit: ${screen.text.length}`,
    );
    for (const row of screen.keyboard.reply_markup.inline_keyboard) {
      for (const button of row) {
        if ("callback_data" in button)
          assert.ok(Buffer.byteLength(button.callback_data) <= 64);
      }
    }
  }
});

test("shopping item rows are neutral while grouped controls and pagination use native primary styling", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const items = store.addItems(
    Array.from({ length: 8 }, (_, i) => `Tuote ${i}`),
    actor,
  ).added;
  store.addTask("Homma", "1vk", "2026-10-13", actor);
  for (const tab of ["active", "bought", "removed"] as const) {
    if (tab === "bought") store.changeItem(items[0].id, 0, "buy", actor);
    if (tab === "removed") store.changeItem(items[0].id, 1, "remove", actor);
    for (const edit of [false, true]) {
      const screen = renderView(
        store,
        { kind: "shopping", tab, page: 0, edit },
        "2026-10-13",
      );
      const rows = screen.keyboard.reply_markup.inline_keyboard;
      for (const button of rows.flat()) {
        assert.ok("callback_data" in button);
        if (!("callback_data" in button))
          throw new Error("Expected callback button");
        const isItem = /^(si:|item:)/.test(button.callback_data);
        if (isItem) assert.ok(!("style" in button));
        else {
          assert.ok("style" in button);
          assert.equal(button.style, "primary");
        }
      }
      const addRow = rows.find((row) =>
        row.some(
          (button) =>
            "callback_data" in button && button.callback_data === "capture",
        ),
      )!;
      assert.equal(addRow.length, 2);
      assert.ok(
        JSON.stringify(screen.keyboard.reply_markup).includes(
          '"style":"primary"',
        ),
      );
    }
  }
  const itemCard = renderView(
    store,
    { kind: "item", id: items[0].id },
    "2026-10-13",
  );
  assert.ok(
    itemCard.keyboard.reply_markup.inline_keyboard
      .flat()
      .every((button) => "style" in button && button.style === "primary"),
  );
  const tasks = renderView(
    store,
    { kind: "tasks", tab: "due", page: 0 },
    "2026-10-13",
  );
  for (const button of tasks.keyboard.reply_markup.inline_keyboard.flat()) {
    assert.ok("callback_data" in button);
    if (!("callback_data" in button))
      throw new Error("Expected callback button");
    if (button.callback_data.startsWith("task:"))
      assert.ok(!("style" in button));
    else assert.ok("style" in button && button.style === "primary");
  }
});

test("shopping footer undo follows the latest shopping event, ignores task events and never offers redo", (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  const item = store.addItems(["Maito"], actor).added[0];
  const bought = changed(store.changeItem(item.id, 0, "buy", spouse));
  store.addTask("Homma", "1vk", "2026-10-13", actor);
  assert.equal(store.latestEvent("shopping")?.id, bought);
  assert.equal(store.latestEvent("shopping", item.id)?.id, bought);
  const callbacks = () =>
    renderView(
      store,
      {
        kind: "shopping",
        tab: "active",
        page: 0,
        edit: false,
      },
      "2026-10-13",
    )
      .keyboard.reply_markup.inline_keyboard.flat()
      .filter(
        (button) =>
          "callback_data" in button && button.callback_data.startsWith("undo:"),
      );
  const beforeUndo = callbacks();
  assert.equal(beforeUndo.length, 1);
  const undoButton = beforeUndo[0];
  assert.ok(
    "callback_data" in undoButton &&
      undoButton.callback_data === `undo:${bought}`,
  );
  changed(store.undo(bought, actor));
  assert.equal(callbacks().length, 0);
  assert.equal(store.latestEvent("shopping")?.action, "undo");
  assert.equal(store.latestEvent("shopping", 999), undefined);
});
