import { App } from "@tinyhttp/app";
import { logger } from "@tinyhttp/logger";
import { Telegraf } from "telegraf";
import config from "./config";
import { tgMiddleware } from "./middleware";

const app = new App();
console.log(`Setting up Telegram bot with token ${config.tgBotToken}`);
const bot = new Telegraf(config.tgBotToken);

bot.use(tgMiddleware.auth);
bot.command("/start", (ctx) => ctx.reply("started"));
bot.command("/stop", (ctx) => ctx.reply("stopped"));

app
  .use(logger({
    timestamp: {
      format: "YYYY-MM-DDTHH:mm:ssZ[Z]",
    },
  }))
  .use(bot.webhookCallback("/webhook/telegram"))
  .get("/", (_, res) => {
    res.send({ service: "hommabot2 API" });
  })
  .post("/scheduler/trigger", (_req, res) => {
    res.send({ scheduler: "trigger" });
  });

console.log(`Setting up webhook on ${config.tgWebhookUrl}`);
bot.telegram.setWebhook(config.tgWebhookUrl);

console.log(`Serving on http://localhost:${config.port}`);
app.listen(config.port);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
