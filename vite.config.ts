import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => {
  const isCapacitor = mode === 'capacitor';

  const plugins: PluginOption[] = [react()];

  // Web/Render ビルド時のみ PWA (Service Worker) を有効化
  // Capacitor ネイティブビルド時はローカルアセット配信と競合するため無効化
  if (!isCapacitor) {
    plugins.push(
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
        manifest: {
          name: '3D Brain MRI Atlas',
          short_name: 'BrainAtlas',
          description: '臨床神経解剖・209構造対応 3D脳MRIアトラス',
          theme_color: '#111111',
          background_color: '#000000',
          display: 'standalone',
          orientation: 'landscape',
          start_url: '/',
          icons: [
            {
              src: 'pwa-192x192.png',
              sizes: '192x192',
              type: 'image/png',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
            },
            {
              src: 'pwa-512x512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png}'],
          runtimeCaching: [
            {
              urlPattern: /\.(?:bin(?:\.gz)?|json)$/i,
              handler: 'CacheFirst',
              options: {
                cacheName: 'brain-mri-volumes-v2',
                expiration: {
                  maxEntries: 20,
                  maxAgeSeconds: 60 * 60 * 24 * 90,
                },
                cacheableResponse: {
                  statuses: [0, 200],
                },
              },
            },
          ],
        },
      }) as unknown as PluginOption
    );
  }

  return {
    plugins,
  };
});
