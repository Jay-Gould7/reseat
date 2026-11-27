import { defineConfig, loadEnv, type PreviewServer, type ViteDevServer } from "vite";
import { createWaitlistApi } from "./relay/service.mjs";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  function attachRelay(server: ViteDevServer | PreviewServer) {
    const api = createWaitlistApi(loadEnv(mode, "../", ["WAITLIST_", "VITE_", "BASE_SEPOLIA_RPC_URL", "LASNA_RPC_URL"]));
    server.middlewares.use((req, res, next) => { void api.handle(req, res).then(handled => { if (!handled) next(); }, next); });
    server.httpServer?.once("close", () => api.close());
  }
  return {
    plugins: [react(), tailwindcss(), { name: "reseat-waitlist-api", configureServer: attachRelay, configurePreviewServer: attachRelay }],
    envDir: "..",
    build: { rollupOptions: { output: { manualChunks: { ethers: ["ethers"] } } } },
  };
});
