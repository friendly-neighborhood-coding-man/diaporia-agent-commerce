// Recording-only launcher: the repo's own offline MOCK demo world (scripts/buy-panel/demo-app.ts), no self-call.
import { createDemoWorldApp } from "/home/user/diaporia-agent-commerce/scripts/buy-panel/demo-app.ts";
const port = Number(process.env.PORT ?? 8790), host = "127.0.0.1";
const { app } = createDemoWorldApp({ host, port, baseUrl: `http://${host}:${port}`, dbPath: ":memory:", userId: "demo-user",
  clientToken: process.env.TOK!, ownerKey: process.env.OWN!, researchDelayMs: Number(process.env.DELAY ?? 600) });
await new Promise<void>((r) => app.server.listen(port, host, r));
console.log("listening", port);
