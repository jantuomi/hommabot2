import { Markup, Telegraf } from "telegraf";
import config from "./config";
import {
  addActiveChat, getActiveChats, removeActiveChat,
  addShoppingItem, getShoppingList, removeShoppingItem,
  addRecurringTask, getRecurringTasks, updateRecurringTask, markTaskDone, removeRecurringTask,
} from "./db";
import { tgAuth } from "./middleware";
import { getNextDate, formatDate, parseInterval, today } from "./tasks";

const bot = new Telegraf(config.tgBotToken);
bot.use(tgAuth);

bot.command("/start", async (ctx) => {
  await addActiveChat(ctx.chat.id);
  await ctx.reply("HommaBot startattu. Uusia hommapäivityksiä viikon välein.");
});

bot.command("/stop", async (ctx) => {
  await removeActiveChat(ctx.chat.id);
  await ctx.reply("HommaBot pysäytetty!");
});

// --- Shopping list ---

bot.command("add", async (ctx) => {
  const item = ctx.message.text.replace(/^\/add\s*/, "").trim();
  if (!item) { await ctx.reply("Käyttö: /add <tuote>"); return; }
  addShoppingItem(item, ctx.message.from.id);
  await ctx.reply(`Lisätty: ${item}`);
});

bot.command("list", async (ctx) => {
  const items = getShoppingList();
  if (items.length === 0) { await ctx.reply("Ostoslista on tyhjä."); return; }
  const text = items.map((i, idx) => `${idx + 1}. ${i.item}`).join("\n");
  const buttons = items.map((i) => [Markup.button.callback(`❌ ${i.item}`, `del:${i.id}`)]);
  await ctx.reply(`🛒 Ostoslista:\n${text}`, Markup.inlineKeyboard(buttons));
});

bot.action(/^del:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  removeShoppingItem(id);
  await ctx.answerCbQuery("Poistettu!");
  const items = getShoppingList();
  if (items.length === 0) { await ctx.editMessageText("Ostoslista on tyhjä."); return; }
  const text = items.map((i, idx) => `${idx + 1}. ${i.item}`).join("\n");
  const buttons = items.map((i) => [Markup.button.callback(`❌ ${i.item}`, `del:${i.id}`)]);
  await ctx.editMessageText(`🛒 Ostoslista:\n${text}`, Markup.inlineKeyboard(buttons));
});

// --- Recurring tasks ---

bot.command("newtask", async (ctx) => {
  const args = ctx.message.text.replace(/^\/newtask\s*/, "").trim();
  const match = /^(\d+(?:pv|vk|kk|v))\s+(.+)$/.exec(args);
  if (!match) {
    await ctx.reply("Käyttö: /newtask <intervalli> <nimi>\nEsim: /newtask 2vk Imurointi\n\nIntervallit: pv, vk, kk, v");
    return;
  }
  try {
    parseInterval(match[1]);
  } catch {
    await ctx.reply("Virheellinen intervalli. Käytä: pv, vk, kk, v (esim. 2vk, 1kk)");
    return;
  }
  addRecurringTask(match[2], match[1]);
  await ctx.reply(`✅ Uusi tehtävä: ${match[2]} (joka ${match[1]})`);
});

bot.command("tasks", async (ctx) => {
  const tasks = getRecurringTasks();
  if (tasks.length === 0) { await ctx.reply("Ei tehtäviä. Lisää: /newtask"); return; }
  const lines = tasks.map((t) => {
    const next = formatDate(getNextDate(t));
    const done = t.last_done || "—";
    return `*${t.id}.* ${t.name}\n   ↻ ${t.interval} | edellinen: ${done} | seuraava: ${next}`;
  });
  const buttons = tasks.map((t) => [
    Markup.button.callback(`✅`, `taskdone:${t.id}`),
    Markup.button.callback(`🗑️`, `taskdel:${t.id}`),
  ]);
  await ctx.reply(`📋 Toistuvat tehtävät:\n\n${lines.join("\n\n")}`, {
    parse_mode: "Markdown",
    ...Markup.inlineKeyboard(buttons),
  });
});

bot.command("edittask", async (ctx) => {
  const args = ctx.message.text.replace(/^\/edittask\s*/, "").trim();
  const match = /^(\d+)\s+(\d+(?:pv|vk|kk|v))\s+(.+)$/.exec(args);
  if (!match) {
    await ctx.reply("Käyttö: /edittask <id> <intervalli> <nimi>\nEsim: /edittask 3 1kk Ikkunoiden pesu");
    return;
  }
  try {
    parseInterval(match[2]);
  } catch {
    await ctx.reply("Virheellinen intervalli.");
    return;
  }
  updateRecurringTask(Number(match[1]), match[3], match[2]);
  await ctx.reply(`✏️ Päivitetty: ${match[3]} (${match[2]})`);
});

bot.command("done", async (ctx) => {
  const idStr = ctx.message.text.replace(/^\/done\s*/, "").trim();
  const id = Number(idStr);
  if (!id) { await ctx.reply("Käyttö: /done <id>"); return; }
  markTaskDone(id, today());
  await ctx.reply("✅ Merkitty tehdyksi!");
});

bot.action(/^taskdone:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  markTaskDone(id, today());
  await ctx.answerCbQuery("Merkitty tehdyksi!");
});

bot.action(/^taskdel:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  removeRecurringTask(id);
  await ctx.answerCbQuery("Poistettu!");
});

const broadcastMessage = async (msg: string): Promise<void> => {
  const activeChats = await getActiveChats();
  await Promise.all(activeChats.map((c) => bot.telegram.sendMessage(c.id, msg)));
};

export { bot, broadcastMessage };
