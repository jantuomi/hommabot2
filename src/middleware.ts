import { Context } from "telegraf";
import { getPermittedUsers } from "./db";

const auth = async (ctx: Context, next: () => Promise<void>): Promise<void> => {
  const userId = ctx.message?.from.id;

  const tgUsers = await getPermittedUsers();
  const tgUserIds = tgUsers.map(u => u.id);

  if (!userId || !tgUserIds.includes(userId)) {
    ctx.reply("Käyttäjälläsi ei ole oikeuksia startata HommaBottia.");
  } else {
    await next();
  }
};

export const tgMiddleware = {
  auth,
};

export const httpMiddleware = {};
