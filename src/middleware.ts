import { Context } from "telegraf";
import config from "./config";

const auth = async (ctx: Context, next: () => Promise<void>): Promise<void> => {
  const userId = ctx.message?.from.id;

  if (!userId || !config.tgUserIds.includes(userId)) {
    ctx.reply("Käyttäjälläsi ei ole oikeuksia startata HommaBottia.");
  } else {
    await next();
  }
};

export const tgMiddleware = {
  auth,
};

export const httpMiddleware = {};
