import dotenv from "dotenv";

if (!process.env.SKIP_DOTENV) {
  dotenv.config();
}

class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const tgWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL || null;
if (!tgWebhookUrl) {
  throw new ConfigError("Missing env var TELEGRAM_WEBHOOK_URL");
}

const tgBotToken = process.env.TELEGRAM_BOT_TOKEN || null;
if (!tgBotToken) {
  throw new ConfigError("Missing env var TELEGRAM_BOT_TOKEN");
}

const tgUserIds = process.env.TELEGRAM_USER_IDS
  ? process.env.TELEGRAM_USER_IDS?.split(",")
    .map(Number.parseInt)
  : null;
if (!tgUserIds) {
  throw new ConfigError("Missing env var TELEGRAM_USER_IDS");
}

const sheetsSpreadsheetId = process.env.SHEETS_SPREADSHEET_ID || null;
if (!sheetsSpreadsheetId) {
  throw new ConfigError("Missing env var SHEETS_SPREADSHEET_ID");
}

const sheetsRange = process.env.SHEETS_RANGE || null;
if (!sheetsRange) {
  throw new ConfigError("Missing env var SHEETS_RANGE");
}

const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  tgWebhookUrl,
  tgBotToken,
  tgUserIds,
  sheetsSpreadsheetId,
  sheetsRange,
};

export default config;