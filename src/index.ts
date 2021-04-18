import { App } from "@tinyhttp/app";
import { logger } from "@tinyhttp/logger";

const app = new App();
const port = process.env.PORT ? Number(process.env.PORT) : 3000;

app
  .use(logger({
    timestamp: {
      format: "YYYY-MM-DDTHH:mm:ssZ[Z]"
    }
  }))
  .use(function someMiddleware(_req, _res, next) {
    console.log("Did a request");
    next();
  })
  .get("/", (_, res) => {
    res.send("<h1>Hello World</h1>");
  })
  .get("/page/:page/", (req, res) => {
    res.status(200).send(`You just opened ${req.params?.page}`);
  });

console.log(`Serving on http://localhost:${port}`);
app.listen(port);
