import { App } from "@tinyhttp/app";
import { logger } from "@tinyhttp/logger";
import config from "./config";
import { broadcast } from "./sheets";
import { bot } from "./tg";

const app = new App({
  onError: (err, _req, res) => {
    console.log(err);
    res.status(500).send("Something bad happened");
  },
});

app
  .use(logger({
    timestamp: {
      format: "YYYY-MM-DDTHH:mm:ssZ[Z]",
    },
  }))
  .use(bot.webhookCallback("/webhook/telegram"))
  .get("/", async (_, res) => {
    res.send({ service: "hommabot2 API" });
  })
  .post("/scheduler/trigger", async (_req, res) => {
    await broadcast();
    res.send({ scheduler: "trigger" });
  });

console.log(`Setting up webhook on ${config.tgWebhookUrl}`);
bot.telegram.setWebhook(config.tgWebhookUrl);

console.log(`Serving on http://localhost:${config.port}`);
app.listen(config.port);

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
