import { Telegraf } from "telegraf";
import config from "./config";
import { addActiveChat, removeActiveChat } from "./db";
import { tgMiddleware } from "./middleware";

console.log(`Setting up Telegram bot with token ${config.tgBotToken}`);
const bot = new Telegraf(config.tgBotToken);

bot.use(tgMiddleware.auth);

bot.command("/start", async (ctx) => {
  await addActiveChat(ctx.chat.id);
  await ctx.reply("HommaBot startattu. Uusia hommapäivityksiä viikon välein.");
});

bot.command("/stop", async (ctx) => {
  await removeActiveChat(ctx.chat.id);
  await ctx.reply("HommaBot pysäytetty!");
});

export { bot };
