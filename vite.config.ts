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
  build: {
    chunkSizeWarningLimit: 2500,
  },
  server: {
    headers: {
      // ── Content Security Policy (dev mirror of index.html meta tag) ─────────
      // Kept in sync with the <meta http-equiv="Content-Security-Policy"> in
      // index.html. Having it here as an HTTP header means it applies before
      // the HTML is parsed and covers the Vite dev server manifest requests too.
      "Content-Security-Policy": [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",  // 'wasm-unsafe-eval' allows WebAssembly (e.g. Argon2) without enabling arbitrary eval()
        "style-src 'self' 'unsafe-inline'",
        "connect-src 'self' https://*.supabase.co wss://*.supabase.co ws://localhost:*",
        "img-src 'self' data: blob: https://*.supabase.co",
        "media-src 'self' blob:",
        "worker-src 'self' blob:",
        "font-src 'self' data:",
        "frame-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join("; "),

      // ── Security headers ────────────────────────────────────────────────────
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=*, microphone=*, geolocation=()",
    },
  },
});
