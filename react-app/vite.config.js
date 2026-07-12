import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(() => {
  const apiProxyTarget = process.env.VITE_DEV_API_PROXY_TARGET || "http://localhost:3000";

  return {
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: apiProxyTarget
        },
        "/media": {
          target: apiProxyTarget
        }
      }
    }
  };
});
