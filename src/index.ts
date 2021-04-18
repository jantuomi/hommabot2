import { App } from "@tinyhttp/app";
import { logger } from "@tinyhttp/logger";
import { auth } from "./middleware";

const app = new App();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app
  .use(logger({
    timestamp: {
      format: "YYYY-MM-DDTHH:mm:ssZ[Z]",
    },
  }))
  .use(auth)
  .get("/", (_, res) => {
    res.send({ foo: "bar" });
  })
  .post("/webhook/start", (_req, res) => {
    res.send({ webhook: "start" });
  })
  .post("/webhook/stop", (_req, res) => {
    res.send({ webhook: "stop" });
  })
  .post("/scheduler/trigger", (_req, res) => {
    res.send({ scheduler: "trigger" });
  });

console.log(`Serving on http://localhost:${port}`);
app.listen(port);
