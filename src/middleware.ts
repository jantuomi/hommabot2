import { Request, Response } from "@tinyhttp/app";
import { Context } from "telegraf";
import config from "./config";

import { getPermittedUsers } from "./db";

const tgAuth = async (ctx: Context, next: () => Promise<void>): Promise<void> => {
  const userId = ctx.message?.from.id;

  const tgUsers = await getPermittedUsers();
  const tgUserIds = tgUsers.map(u => u.id);

  if (!userId || !tgUserIds.includes(userId)) {
    ctx.reply("Käyttäjälläsi ei ole oikeuksia startata HommaBottia.");
  } else {
    await next();
  }
};

const httpHeaderAuth = async (req: Request, res: Response, next: () => void): Promise<void> => {
  const authHeader = req.headers.authorization || null;
  if (!authHeader) {
    res.sendStatus(401);
    return;
  }

  const token = authHeader.split(" ")[1];
  if (!token || token !== config.authToken) {
    res.sendStatus(401);
    return;
  }

  next();
}

export {
  tgAuth,
  httpHeaderAuth,
};
