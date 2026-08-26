import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
    plugins: [vue()],
    server: {
        host: true,
        port: 5173
    },
    // Capacitor 构建产物输出到 www，供原生壳加载
    build: {
        outDir: 'www',
        sourcemap: false
    },
    base: './'
});
