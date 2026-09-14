import { buildApp } from "./app";

const app = buildApp({ logger: true });
const PORT = Number(process.env.PORT ?? 3001);

app
  // host: "0.0.0.0" is required on Render (and most container platforms) —
  // Fastify's own default, 127.0.0.1, only accepts connections from inside
  // the container itself. The platform's own proxy connects from outside
  // it, so a loopback-only bind is invisible to real traffic even though
  // the process itself starts and looks "live" — confirmed live: TLS
  // handshake with Render's edge succeeded, but every request past that
  // just hung with zero bytes back, since it never reached the app.
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`Revolution Day server listening on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
