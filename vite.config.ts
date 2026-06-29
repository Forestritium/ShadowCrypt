import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
    dedupe: ["react", "react-dom", "react-router", "react-router-dom"],
  },
  // Ensure PWA assets are served with correct MIME types in dev
  server: {
    headers: {
      // Allow the manifest to be fetched cross-origin (required by some browsers)
      "Access-Control-Allow-Origin": "*",
    },
  },
});
