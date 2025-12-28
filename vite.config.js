import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    vue(),
    VitePWA({
      registerType: 'prompt',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/api\..*/i,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'api-cache',
              networkTimeoutSeconds: 10,
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /.*\.(js|css|html)$/,
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'static-cache'
            }
          }
        ]
      },
      includeAssets: ['favicon.ico', 'robots.txt', 'icons/*.png'],
      manifest: {
        name: 'MiSub - 订阅转换器',
        short_name: 'MiSub',
        description: '基于 Cloudflare 的订阅转换和管理工具',
        theme_color: '#4f46e5',
        background_color: '#0f172a',
        display: 'standalone',
        orientation: 'portrait-primary',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '72x72',
            type: 'image/png'
          },
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '96x96',
            type: 'image/png'
          },
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '128x128',
            type: 'image/png'
          },
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '144x144',
            type: 'image/png'
          },
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '152x152',
            type: 'image/png'
          },
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '384x384',
            type: 'image/png'
          },
          {
            src: '/icons/IMG_0477.PNG',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      },
      devOptions: {
        enabled: true,
        type: 'module'
      }
    })
  ],
  // 我们移除了所有 alias 配置
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
      '/sub': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      }
    }
  }
})