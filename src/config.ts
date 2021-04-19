import dotenv from "dotenv";
import fs from "fs";
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

const tgWebhookUrl = process.env.TELEGRAM_WEBHOOK_URL || null;
if (!tgWebhookUrl) {
  throw new ConfigError("Missing env var TELEGRAM_WEBHOOK_URL");
}

const tgBotToken = process.env.TELEGRAM_BOT_TOKEN || null;
if (!tgBotToken) {
  throw new ConfigError("Missing env var TELEGRAM_BOT_TOKEN");
}

const sheetsSpreadsheetId = process.env.SHEETS_SPREADSHEET_ID || null;
if (!sheetsSpreadsheetId) {
  throw new ConfigError("Missing env var SHEETS_SPREADSHEET_ID");
}

const sheetsRange = process.env.SHEETS_RANGE || null;
if (!sheetsRange) {
  throw new ConfigError("Missing env var SHEETS_RANGE");
}

const pgConnectionUri = process.env.PG_CONNECTION_URI || null;
if (!pgConnectionUri) {
  throw new ConfigError("Missing env var PG_CONNECTION_URI");
}

const googleSaJsonB64 = process.env.G_SA_JSON_B64 || null;
if (!googleSaJsonB64) {
  throw new ConfigError("Missing env var G_SA_JSON_B64");
}

const googleSaJsonBuff = Buffer.from(googleSaJsonB64, "base64");
const googleSaJsonUtf8 = googleSaJsonBuff.toString("utf-8");
const googleSaJson: Record<string, string> = JSON.parse(googleSaJsonUtf8);
const googleSaJsonPath = path.join("sa_key.json");
fs.writeFileSync(googleSaJsonPath, googleSaJsonUtf8);

const config = {
  port: process.env.PORT ? Number(process.env.PORT) : 3000,
  tgWebhookUrl,
  tgBotToken,
  sheetsSpreadsheetId,
  sheetsRange,
  pgConnectionUri,
  googleSaJson,
  googleSaJsonPath,
};

export default config;
