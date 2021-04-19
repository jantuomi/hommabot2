import { Request, Response } from "@tinyhttp/app";
import { Context } from "telegraf";
import got from "got";
import jwt from "jsonwebtoken";

import { getPermittedUsers } from "./db";
import config from "./config";

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

const verifyGoogleJWT = async (req: Request, res: Response, next: () => void): Promise<void> => {
  if (config.nodeEnv !== "production") {
    next();
    return;
  }

  const authHeader = req.headers.authorization || null;
  if (!authHeader) {
    res.sendStatus(401);
    return;
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    res.sendStatus(401);
    return;
  }

  const decoded = jwt.decode(token, { complete: true });
  if (!decoded) {
    res.sendStatus(401);
    return;
  }

  const kid: string = decoded.header.kid;

  const response = await got("https://www.googleapis.com/oauth2/v1/certs", { json: true });
  const googleCerts: Record<string, string> = response.body;

  const cert = googleCerts[kid];
  if (!cert) {
    console.error("KID not found in google certificates");
    res.sendStatus(500);
    return;
  }

  try {
    jwt.verify(token, cert);
  } catch (err) {
    res.sendStatus(403);
    return;
  }

  next();
};

export const tgMiddleware = {
  tgAuth,
};

export const httpMiddleware = {
  verifyGoogleJWT,
};
