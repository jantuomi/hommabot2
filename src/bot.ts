import config from "./config";
import { store } from "./db";
import { bot } from "./tg";
import { createReminderRunner } from "./reminders";

const runReminders = createReminderRunner(
  store,
  async (chatId, screen) => {
    const sent = await bot.telegram.sendMessage(
      chatId,
      screen.text,
      screen.keyboard,
    );
    return sent.message_id;
  },
  config.tz,
);

let timer: ReturnType<typeof setInterval> | undefined;
const checkReminders = () => {
  runReminders().catch((error) =>
    console.error("[reminders] Check failed:", error),
  );
};

const start = async () => {
  await bot.telegram.setMyCommands([
    { command: "start", description: "Valikko ja viikkomuistutukset päälle" },
    { command: "list", description: "Ostoslista" },
    { command: "add", description: "Lisää ostoksia" },
    { command: "tasks", description: "Tämän viikon ja myöhässä olevat hommat" },
    {
      command: "week",
      description: "Näytä viikon ja tekemättömät hommat uudelleen",
    },
    {
      command: "done",
      description: "Lopeta ostosten lisäys / merkitse homma tehdyksi",
    },
    { command: "newtask", description: "Lisää uusi homma" },
    { command: "cancel", description: "Lopeta nykyinen syöttövaihe" },
    { command: "help", description: "Käyttöohjeet" },
    { command: "stop", description: "Viikkomuistutukset pois" },
  ]);
  await bot.launch({}, () => {
    console.log("[bot] Running; weekly reminders Monday 09:00:", config.tz);
    timer = setInterval(checkReminders, 60 * 1000);
    checkReminders();
  });
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (timer) clearInterval(timer);
    bot.stop(signal);
  });
}

start().catch((error) => {
  console.error("[bot] Startup failed:", error);
  if (timer) clearInterval(timer);
  process.exitCode = 1;
});
