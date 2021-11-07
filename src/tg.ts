import { Telegraf } from "telegraf";
import config from "./config";
import { addActiveChat, getActiveChats, removeActiveChat } from "./db";
import { tgAuth } from "./middleware";

console.log(`Setting up Telegram bot with token ${config.tgBotToken}`);
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

const broadcastMessage = async (msg: string): Promise<void> => {
  const activeChats = await getActiveChats();
  const chatIds = activeChats.map(c => c.id);

  await Promise.all(chatIds.map(async chatId =>
    bot.telegram.sendMessage(chatId, msg),
  ));
};

export { bot, broadcastMessage };
