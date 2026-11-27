import { createServer } from "node:http";
import { createWaitlistApi } from "./service.mjs";

const api = createWaitlistApi(process.env);
const server = createServer(async (req, res) => {
  if (!await api.handle(req, res)) { res.writeHead(404); res.end(); }
});
server.listen(Number(process.env.PORT || 8787), "127.0.0.1");
server.on("close", () => api.close());
