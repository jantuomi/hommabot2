import dotenv from "dotenv";
import path from "path";

if (!process.env.SKIP_DOTENV) {
  dotenv.config();
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const tgBotToken = process.env.TELEGRAM_BOT_TOKEN || null;
if (!tgBotToken) {
  throw new ConfigError("Missing env var TELEGRAM_BOT_TOKEN");
}

const tz = process.env.TZ || "Europe/Helsinki";

const sqlitePath =
  process.env.SQLITE_PATH || path.join(process.cwd(), "data", "hommabot.db");

const config = {
  tgBotToken,
  tz,
  sqlitePath,
};

export default config;
