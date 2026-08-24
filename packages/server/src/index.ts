import { buildApp } from "./app";

const app = buildApp({ logger: true });
const PORT = Number(process.env.PORT ?? 3001);

app
  .listen({ port: PORT })
  .then(() => app.log.info(`Revolution Day server listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
