/**
 * Telegram-only middleware utilities.
 *
 * HTTP server functionality has been removed, so any HTTP-specific middleware
 * (e.g. header-based auth) has been deleted.
 *
 * This module currently exposes:
 *   tgAuth - Ensures that only permitted Telegram user IDs can invoke bot commands.
 */

import { Context } from "telegraf";
import { getPermittedUsers } from "./db";

/**
 * Telegram authorization middleware.
 *
 * Logic:
 * 1. Extract the Telegram user ID from the incoming context.
 * 2. Load the list of permitted user IDs from the SQLite database.
 * 3. If the user ID is not present, reply with an authorization failure message
 *    and do NOT call next().
 * 4. Otherwise, continue to the next middleware/handler.
 */
export const tgAuth = async (
  ctx: Context,
  next: () => Promise<void>,
): Promise<void> => {
  const userId = ctx.message?.from.id;
  if (!userId) {
    await ctx.reply("Käyttäjätunnusta ei voitu lukea (user id puuttuu).");
    return;
  }

  try {
    const permitted = await getPermittedUsers();
    const permittedIds = new Set(permitted.map((u) => u.id));

    if (!permittedIds.has(userId)) {
      await ctx.reply("Käyttäjälläsi ei ole oikeuksia käyttää HommaBottia.");
      return;
    }

    await next();
  } catch (err) {
    console.error("[tgAuth] Authorization check failed:", err);
    await ctx.reply("Odottamaton virhe valtuutuksessa.");
  }
};
