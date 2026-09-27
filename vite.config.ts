import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import frappeui from 'frappe-ui/vite'
export default defineConfig({
  base: process.env.FERN_BASE_PATH || '/',
  plugins: [frappeui({ frappeProxy: false, jinjaBootData: false, buildConfig: false }), vue()],
  define: { 'process.env': {} },
  optimizeDeps: { include: ['uniffi-bindgen-react-native'] },
  build: { target: 'esnext' },
  server: { port: 5173, strictPort: true },
})
