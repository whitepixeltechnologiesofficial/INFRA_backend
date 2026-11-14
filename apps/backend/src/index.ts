import "dotenv/config";
import { createApp } from "./app.js";
import { assertDbTransport } from "./db/index.js";

const PORT = process.env.PORT ?? 4000;

const { httpServer } = createApp();
httpServer.listen(PORT, () => {
  console.log(`@wpt/backend listening on :${PORT}`);
});

assertDbTransport().catch((err) => {
  console.error(`[db] transport check failed: ${(err as Error).message}`);
  process.exit(1);
});
