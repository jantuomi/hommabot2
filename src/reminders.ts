import type { HouseholdStore, RecurringTask, View } from "./storage";
import { dueThisWeek, today, weeklyRunKey } from "./tasks";
import { renderView, type Screen } from "./ui";

export type SendScreen = (chatId: number, screen: Screen) => Promise<number>;
const snoozeRevision = (task: RecurringTask): number => {
  if (task.snooze_revision === null)
    throw new Error(`Missing snooze metadata for task ${task.id}`);
  return task.snooze_revision;
};

export const createReminderRunner = (
  store: HouseholdStore,
  send: SendScreen,
  timeZone: string,
  clock: () => Date = () => new Date(),
) => {
  let running = false;
  const retryAfter = new Map<number, number>();
  return async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const instant = clock();
      const date = today(timeZone, instant);
      const week = weeklyRunKey(instant, timeZone);
      const hour = Number(
        new Intl.DateTimeFormat("en-GB", {
          timeZone,
          hour: "2-digit",
          hourCycle: "h23",
        }).format(instant),
      );
      for (const chatId of store.activeChats()) {
        if ((retryAfter.get(chatId) ?? 0) > instant.getTime()) continue;
        try {
          if (week && !store.reminderSent(week, chatId)) {
            const included = store
              .tasks()
              .filter((task) => dueThisWeek(task, date));
            const view: View = { kind: "tasks", tab: "due", page: 0 };
            const messageId = await send(chatId, renderView(store, view, date));
            store.recordReminder(week, chatId);
            store.trackView(chatId, messageId, view);
            for (const task of included) {
              if (task.snoozed_until && task.snoozed_until <= date) {
                store.recordSnoozeReminder(
                  task.id,
                  snoozeRevision(task),
                  chatId,
                );
              }
            }
          }
          if (hour < 9) continue;
          for (const task of store.tasks()) {
            if (
              task.snoozed_until &&
              task.snoozed_until <= date &&
              dueThisWeek(task, date) &&
              !store.snoozeReminderSent(task.id, snoozeRevision(task), chatId)
            ) {
              const view: View = { kind: "task", id: task.id };
              const screen = renderView(store, view, date);
              screen.text = `💤 Siirretty muistutus\n\n${screen.text}`;
              const messageId = await send(chatId, screen);
              store.recordSnoozeReminder(task.id, snoozeRevision(task), chatId);
              store.trackView(chatId, messageId, view);
            }
          }
          retryAfter.delete(chatId);
        } catch (error) {
          // Failed deliveries stay pending; one inaccessible chat cannot block another.
          console.error("[reminders] Delivery failed:", chatId, error);
          retryAfter.set(chatId, instant.getTime() + 15 * 60 * 1000);
        }
      }
    } finally {
      running = false;
    }
  };
};
