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
  // Replit(dev 모드 배포)에서는 vite가 5000을 서빙하고 API는 3001로 프록시(.replit workflow 참조).
  // 로컬 개발은 기존 규약(5173 → 5000 프록시) 유지.
  server: process.env.REPL_ID
    ? {
        host: true,
        port: 5000,
        strictPort: true,
        allowedHosts: true as const,
        proxy: { "/api": "http://localhost:3001" },
      }
    : {
        host: true,               // 0.0.0.0 for local mobile testing
        port: 5173,
        proxy: { "/api": "http://localhost:5000" },
      },
  build: { outDir: path.resolve(__dirname, "dist/public"), emptyOutDir: true },
});
