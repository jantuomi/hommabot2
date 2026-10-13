import { test } from "node:test";
import assert from "node:assert/strict";
import { HouseholdStore } from "../src/storage";
import { createReminderRunner } from "../src/reminders";

const actor = { id: 10, name: "Jan" };

test("weekly reminders include overdue tasks, never mark them done and persist per-chat deliveries", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  store.subscribe(2);
  const id = store.addTask("Imurointi", "2vk", "2026-09-01", actor);
  const calls: { chat: number; text: string }[] = [];
  const clock = () => new Date("2026-10-13T09:00:00Z");
  const send = async (chat: number, screen: { text: string }) => {
    calls.push({ chat, text: screen.text });
    return calls.length;
  };
  const run = createReminderRunner(store, send, "Europe/Helsinki", clock);
  await run();
  assert.equal(calls.length, 2);
  assert.ok(calls[0].text.includes("myöhässä"));
  assert.equal(store.task(id)?.last_done, null);
  assert.equal(store.task(id)?.revision, 0);
  await run();
  const restarted = createReminderRunner(store, send, "Europe/Helsinki", clock);
  await restarted();
  assert.equal(calls.length, 2);
  assert.equal(store.views().length, 2);
  assert.equal(store.reminderSent("2026-10-12", 1), true);
});

test("Monday before 09:00 is quiet, later startup catches up and overlapping checks do not duplicate", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-12");
  t.after(() => store.close());
  store.subscribe(1);
  let instant = new Date("2026-10-12T05:59:00Z");
  let count = 0;
  const run = createReminderRunner(
    store,
    async () => {
      count++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return count;
    },
    "Europe/Helsinki",
    () => instant,
  );
  await run();
  assert.equal(count, 0);
  instant = new Date("2026-10-14T09:00:00Z");
  await Promise.all([run(), run(), run()]);
  assert.equal(count, 1);
  instant = new Date("2026-10-19T06:00:00Z");
  await run();
  assert.equal(count, 2);
});

test("delivery failure is retried and does not prevent another chat receiving reminders", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  store.subscribe(2);
  let instant = new Date("2026-10-13T09:00:00Z");
  let fail = true;
  const received: number[] = [];
  const log = t.mock.method(console, "error", () => {});
  const run = createReminderRunner(
    store,
    async (chat) => {
      if (chat === 1 && fail) throw new Error("Temporary send failure");
      received.push(chat);
      return received.length;
    },
    "Europe/Helsinki",
    () => instant,
  );
  await run();
  assert.deepEqual(received, [2]);
  assert.equal(store.reminderSent("2026-10-12", 1), false);
  assert.equal(log.mock.callCount(), 1);
  fail = false;
  await run();
  assert.deepEqual(received, [2]);
  instant = new Date("2026-10-13T09:15:00Z");
  await run();
  assert.deepEqual(received, [2, 1]);
});

test("snoozed reminder wakes at 09:00, is delivered once and leaves completion unchanged", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  store.recordReminder("2026-10-12", 1);
  const id = store.addTask("Suodatin", "1kk", "2026-10-01", actor);
  store.changeTask(id, 0, "snooze", actor, "2026-10-16");
  let instant = new Date("2026-10-16T05:59:00Z");
  const texts: string[] = [];
  const run = createReminderRunner(
    store,
    async (_chat, screen) => {
      texts.push(screen.text);
      return texts.length;
    },
    "Europe/Helsinki",
    () => instant,
  );
  await run();
  assert.equal(texts.length, 0);
  instant = new Date("2026-10-16T06:00:00Z");
  await run();
  await run();
  assert.equal(texts.length, 1);
  assert.ok(texts[0].includes("Suodatin"));
  assert.ok(texts[0].includes("Siirretty muistutus"));
  assert.equal(store.task(id)?.last_done, null);
  assert.equal(store.task(id)?.first_due, "2026-10-01");
});

test("weekly digest and snooze wake do not duplicate the same reminder", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  const id = store.addTask("Suodatin", "1kk", "2026-10-01", actor);
  store.changeTask(id, 0, "snooze", actor, "2026-10-12");
  let calls = 0;
  const run = createReminderRunner(
    store,
    async () => ++calls,
    "Europe/Helsinki",
    () => new Date("2026-10-13T09:00:00Z"),
  );
  await run();
  await run();
  assert.equal(calls, 1);
  assert.equal(store.snoozeReminderSent(id, 1, 1), true);
});

test("delivery bookkeeping uses the sent snapshot, not a task changed while Telegram was sending", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  const id = store.addTask("Suodatin", "1kk", "2026-10-01", actor);
  store.changeTask(id, 0, "snooze", actor, "2026-10-12");
  let calls = 0;
  const run = createReminderRunner(
    store,
    async () => {
      calls++;
      if (calls === 1) store.changeTask(id, 1, "snooze", actor, "2026-10-13");
      return calls;
    },
    "Europe/Helsinki",
    () => new Date("2026-10-13T09:00:00Z"),
  );
  await run();
  assert.equal(store.snoozeReminderSent(id, 1, 1), true);
  assert.equal(store.snoozeReminderSent(id, 2, 1), true);
  assert.equal(calls, 2);
});

test("an expired snooze does not send reminders for tasks before their due week", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  store.recordReminder("2026-10-12", 1);
  const id = store.addTask("Tuleva homma", "1kk", "2026-11-01", actor);
  store.changeTask(id, 0, "snooze", actor, "2026-10-13");
  let calls = 0;
  const run = createReminderRunner(
    store,
    async () => ++calls,
    "Europe/Helsinki",
    () => new Date("2026-10-13T09:00:00Z"),
  );
  await run();
  assert.equal(calls, 0);
});

test("editing a task does not re-deliver an already sent snoozed reminder", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  store.recordReminder("2026-10-12", 1);
  const id = store.addTask("Suodatin", "1kk", "2026-10-01", actor);
  store.changeTask(id, 0, "snooze", actor, "2026-10-13");
  let calls = 0;
  const run = createReminderRunner(
    store,
    async () => ++calls,
    "Europe/Helsinki",
    () => new Date("2026-10-13T09:00:00Z"),
  );
  await run();
  store.changeTask(id, 1, "edit", actor, "2026-10-13", {
    name: "Uusi suodatin",
    interval: "1kk",
  });
  await run();
  assert.equal(calls, 1);
  assert.equal(store.task(id)?.snooze_revision, 1);
  assert.equal(store.task(id)?.revision, 2);
});

test("weekly output retains snoozed unfinished tasks but does not wake them before their chosen date", async (t) => {
  const store = new HouseholdStore(":memory:", "2026-10-13");
  t.after(() => store.close());
  store.subscribe(1);
  const id = store.addTask("Imurointi", "2vk", "2026-10-01", actor);
  store.changeTask(id, 0, "snooze", actor, "2026-11-01");
  const screens: import("../src/ui").Screen[] = [];
  let instant = new Date("2026-10-13T09:00:00Z");
  const run = createReminderRunner(
    store,
    async (_chat, screen) => {
      screens.push(screen);
      return screens.length;
    },
    "Europe/Helsinki",
    () => instant,
  );
  await run();
  assert.equal(screens.length, 1);
  assert.ok(
    screens[0].keyboard.reply_markup.inline_keyboard
      .flat()
      .some(
        (button) =>
          button.text.includes("Imurointi") &&
          button.text.includes("muistutus"),
      ),
  );
  assert.equal(store.task(id)?.last_done, null);
  assert.equal(store.snoozeReminderSent(id, 1, 1), false);
  instant = new Date("2026-10-20T09:00:00Z");
  await run();
  assert.equal(screens.length, 2);
  assert.ok(
    screens[1].keyboard.reply_markup.inline_keyboard
      .flat()
      .some((button) => button.text.includes("Imurointi")),
  );
  assert.equal(store.task(id)?.last_done, null);
});
