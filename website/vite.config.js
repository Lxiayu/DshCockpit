import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径构建：产物可托管在任意子目录或任意静态服务器
  base: './',
  build: {
    target: 'es2019',
    assetsInlineLimit: 8192,
    rollupOptions: {
      output: {
        manualChunks: {
          fonts: ['./src/fonts.js'],
          vendor: ['./src/i18n.js']
        }
      }
    }
  }
});
