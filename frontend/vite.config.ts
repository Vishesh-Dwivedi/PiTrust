import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 3001,
        host: true,
        cors: true,
        allowedHosts: true,
        headers: {
            'X-Frame-Options': 'ALLOWALL',
            'Access-Control-Allow-Origin': '*',
        },
        proxy: {
            '/api': {
                target: 'http://localhost:3000',
                changeOrigin: true,
            },
        },
    },
})
