import type { MiddlewareFn, Context } from "telegraf";
import type { HouseholdStore } from "./storage";

export const authorization =
  (store: HouseholdStore): MiddlewareFn<Context> =>
  async (ctx, next) => {
    if (!ctx.from || !store.permittedUsers().includes(ctx.from.id)) {
      if (ctx.callbackQuery) {
        await ctx.answerCbQuery(
          "Sinulla ei ole oikeuksia käyttää HommaBottia.",
          { show_alert: true },
        );
      } else {
        await ctx.reply("Sinulla ei ole oikeuksia käyttää HommaBottia.");
      }
      return;
    }
    await next();
  };
