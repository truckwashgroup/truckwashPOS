import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [react()],
  // relatief pad is verplicht: Electron laadt via file://
  base: './',
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, 'src') },
  },

  /*
   * Het versienummer uit package.json de app in.
   *
   * De updater vergelijkt op package.json. Zou de app zelf een ander nummer
   * laten zien, dan gaat iemand zoeken naar een update die er al is. Eén bron
   * dus, en die staat hier.
   */
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },

  // Zonder dit doorzoekt Vite ook android/ en ios/. Daar staat een kopie van
  // een eerdere build, en die probeert hij dan als broncode te behandelen --
  // met klachten over pakketten die alleen in die oude bundel voorkomen.
  optimizeDeps: {
    entries: ['index.html'],
  },

  server: {
    // Een andere poort dan het dashboard (5173), zodat je ze naast elkaar kunt
    // laten draaien. Dat wil je bij het werken aan de koppeling ook.
    port: 5174,
    strictPort: true,
    watch: {
      ignored: [
        '**/android/**',
        '**/ios/**',
        '**/dist/**',
        '**/release/**',
      ],
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
})
