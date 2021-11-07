import { App } from "@tinyhttp/app";
import { logger } from "@tinyhttp/logger";
import bodyParser from "body-parser";
import config from "./config";
import { buildSheetsClient } from "./sheets";
import { bot, broadcastMessage } from "./tg";
import { httpHeaderAuth } from "./middleware";

const main = async () => {
  const sheets = await buildSheetsClient();

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
    .use(bodyParser.json())
    .get("/", async (_, res) => {
      res.send({ service: "hommabot2 API" });
    })
    .post("/scheduler/trigger", httpHeaderAuth, async (_req, res) => {
      try {
        const sheetData = await sheets.fetchSheetData();
        const entries = sheets.processRows(sheetData);
        const thisWeeksEntries = sheets.filterOnlyThisWeek(entries);

        if (thisWeeksEntries.length > 0) {
          const tasks = thisWeeksEntries.map(e => `${e.name} (${e.interval})`);
          const taskText = tasks.join("\n");
          const msg = `Tällä viikolla tehtävät hommat:\n${taskText}`;
          await broadcastMessage(msg);
          console.log("Broadcasted message:", msg);
        } else {
          const msg = "Tällä viikolla ei toistuvia hommia! 🎉";
          await broadcastMessage(msg);
          console.log("Broadcasted message:", msg);
        }

        const newDateStamps = sheets.updatedLastDoneDateStamps(entries);
        await sheets.updateSheetLastDoneColumn(newDateStamps);

        res.sendStatus(200);
      } catch (err) {
        console.error(err);
        res.sendStatus(500);
      }
    });

  console.log(`Setting up webhook on ${config.tgWebhookUrl}`);
  bot.telegram.setWebhook(config.tgWebhookUrl);

  console.log(`Serving on http://localhost:${config.port}`);
  app.listen(config.port);

};

main();

// Enable graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
