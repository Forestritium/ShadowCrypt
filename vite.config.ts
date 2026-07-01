import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // Pin react and react-dom to the project's own copies so pnpm's
      // non-flat hoisting never loads a second React instance (which causes
      // useContext to receive null and breaks all hooks inside react-router).
      "react": path.resolve(__dirname, "./node_modules/react"),
      "react-dom": path.resolve(__dirname, "./node_modules/react-dom"),
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
