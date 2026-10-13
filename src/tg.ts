import config from "./config";
import { store } from "./db";
import { createHouseholdBot } from "./app";

export const { bot, refreshViews } = createHouseholdBot(
  config.tgBotToken,
  store,
  config.tz,
);
