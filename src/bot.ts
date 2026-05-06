import { bot, broadcastMessage } from "./tg";
import { getRecurringTasks, markTaskDone } from "./db";
import { isThisWeek, today, now } from "./tasks";
import { isMonday, getHours, format } from "date-fns";

const CHECK_INTERVAL_MS = 60 * 1000;
let lastRunKey: string | null = null;

const runWeeklyTasks = async (): Promise<void> => {
  try {
    console.log("[weekly] Starting recurring tasks check");
    const tasks = getRecurringTasks();
    const dueTasks = tasks.filter(isThisWeek);

    if (dueTasks.length > 0) {
      const taskText = dueTasks.map((t) => `• ${t.name} (${t.interval})`).join("\n");
      await broadcastMessage(`📋 Tällä viikolla tehtävät hommat:\n${taskText}`);
      const todayStr = today();
      for (const t of dueTasks) {
        markTaskDone(t.id, todayStr);
      }
    } else {
      await broadcastMessage("Tällä viikolla ei toistuvia hommia! 🎉");
    }
    console.log("[weekly] Done");
  } catch (err) {
    console.error("[weekly] Error:", err);
  }
};

const checkAndRun = async (): Promise<void> => {
  const current = now();
  if (isMonday(current) && getHours(current) === 9) {
    const key = format(current, "yyyy-MM-dd");
    if (key !== lastRunKey) {
      lastRunKey = key;
      await runWeeklyTasks();
    }
  }
};

setInterval(checkAndRun, CHECK_INTERVAL_MS);
console.log("[bot] Scheduled weekly tasks for Monday 09:00");

bot.launch();
console.log("[bot] Bot is running");

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
