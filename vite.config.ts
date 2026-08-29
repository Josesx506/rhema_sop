import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { viteStaticCopy } from "vite-plugin-static-copy"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Fork: pdf.js needs its standard-font pack and CMaps served alongside
    // the app (PDF text using non-embedded fonts renders blank without
    // them). See src/lib/slides/pdf-import.ts.
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/pdfjs-dist/standard_fonts/*",
          dest: "pdfjs/standard_fonts",
          rename: { stripBase: true },
        },
        {
          src: "node_modules/pdfjs-dist/cmaps/*",
          dest: "pdfjs/cmaps",
          rename: { stripBase: true },
        },
      ],
    }),
  ],
  server: {
    port: 3000,
    strictPort: true,
    watch: {
      // Keep the watcher out of multi-GB non-frontend dirs (Rust build
      // artifacts, ONNX models, NDI SDK). Crawling them blocks the dev
      // server's event loop for minutes on Windows, so the app windows
      // load before Vite can respond and stay white.
      ignored: [
        "**/src-tauri/**",
        "**/models/**",
        "**/embeddings/**",
        "**/sdk/**",
        "**/data/**",
        "**/build/**",
      ],
    },
  },
  build: {
    outDir: "build",
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, "index.html"),
        broadcast: path.resolve(__dirname, "broadcast-output.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
