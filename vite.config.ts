import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron";
import { resolve } from "path";

export default defineConfig({
  plugins: [
    react(),
    electron({
      entry: "src/main/main.ts",
      vite: {
        build: {
          outDir: "dist-electron",
          rollupOptions: {
            external: ["electron"],
          },
        },
      },
      onstart(options) {
        options.startup();
      },
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  base: "./",
});
