import Fastify from "fastify";
import { registerRoutes } from "./routes.js";

const app = Fastify({ logger: { level: "info" } });
registerRoutes(app);

app
  .listen({ port: 3001, host: "0.0.0.0" })
  .then(() => console.log("API: http://localhost:3001"))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
