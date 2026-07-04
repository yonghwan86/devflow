import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  root: path.resolve(__dirname, "client"),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client/src"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  server: {
    host: true,               // 0.0.0.0 for local mobile testing
    port: 5173,
    proxy: { "/api": "http://localhost:5000" },
  },
  build: { outDir: path.resolve(__dirname, "dist/public"), emptyOutDir: true },
});
