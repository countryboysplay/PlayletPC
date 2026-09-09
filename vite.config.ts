import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Fixed port: the desktop shell points its window at this in dev.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: {
    port: 5273,
    strictPort: true,
    // Never watch the Rust build tree. cargo rewrites binaries there constantly and
    // Windows keeps locks on them, so chokidar dies with EBUSY and takes `tauri dev`
    // down with it. Nothing under src-tauri/target is a frontend source anyway.
    watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'] }
  },
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true, sourcemap: true }
})
