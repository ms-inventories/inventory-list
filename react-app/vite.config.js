import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function assetFileNames(assetInfo) {
  const sourceNames = [assetInfo.name, ...(assetInfo.names || []), ...(assetInfo.originalFileNames || [])]
    .filter(Boolean)
    .map(name => String(name).toLowerCase());

  if (sourceNames.some(name => name.endsWith("pdf.worker.min.mjs"))) {
    // Coolify's generated static Nginx image serves .mjs as
    // application/octet-stream. PDF.js starts this file as a module worker,
    // so keep the module unchanged but publish it with the widely supported
    // JavaScript extension.
    return "assets/pdf.worker.min-[hash].js";
  }

  return "assets/[name]-[hash][extname]";
}

export default defineConfig(() => {
  const apiProxyTarget = process.env.VITE_DEV_API_PROXY_TARGET || "http://localhost:3000";

  return {
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          assetFileNames
        }
      }
    },
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
