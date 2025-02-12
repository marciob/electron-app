import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react(),
    electron([
      {
        entry: "src/main/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            sourcemap: true,
            emptyOutDir: true,
            watch: {},
          },
        },
      },
      {
        entry: "src/preload/index.ts",
        vite: {
          build: {
            outDir: "dist-electron/preload",
            sourcemap: true,
          },
        },
        onstart(options) {
          options.reload();
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  base: "./",
  clearScreen: false,
});
