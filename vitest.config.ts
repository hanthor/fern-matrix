import vue from '@vitejs/plugin-vue'
import frappeui from 'frappe-ui/vite'
import { defineConfig } from 'vitest/config'
export default defineConfig({ plugins: [frappeui({ frappeProxy: false, jinjaBootData: false, buildConfig: false }), vue()], test: { include: ['tests/*.test.ts'], server: { deps: { inline: [/frappe-ui/] } } } })
