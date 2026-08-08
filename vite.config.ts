import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // Относительные пути к ассетам. Нужно, чтобы одна и та же сборка работала
  // и на itch.io (страница отдаётся из вложенной папки), и на GitHub Pages,
  // и с локального файла — без пересборки под каждый хостинг.
  base: './',

  build: {
    // Three.js крупный, предупреждение о размере чанка здесь бесполезный шум
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // Отдельный чанк для движка: он меняется редко и хорошо кэшируется
        // между сборками, в отличие от кода игры
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three'
        },
      },
    },
  },
})
