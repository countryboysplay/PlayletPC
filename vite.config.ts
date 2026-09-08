import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'

// Fixed port: the desktop shell points its window at this in dev.
export default defineConfig({
  plugins: [svelte()],
  clearScreen: false,
  server: { port: 5273, strictPort: true },
  build: { target: 'esnext', outDir: 'dist', emptyOutDir: true, sourcemap: true }
})
