import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// IMPORTANT: Replace 'ai-document-analyzer' with your actual GitHub repo name
export default defineConfig({
  plugins: [react()],
  base: '/ai-document-analyzer/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: true,
  },
  optimizeDeps: {
    exclude: ['tesseract.js', 'pdfjs-dist']
  }
})
