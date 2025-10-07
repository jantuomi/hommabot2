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

const nodeEnv = process.env.NODE_ENV || "development";

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

const sqlitePath =
  process.env.SQLITE_PATH || path.join(process.cwd(), "data", "hommabot.db");

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
  nodeEnv,
  tgBotToken,
  sheetsSpreadsheetId,
  sheetsRange,
  sqlitePath,
  googleSaJson,
  googleSaJsonPath,
};

export default config;
