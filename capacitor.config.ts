import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.pvvermouth.brainatlas',
  appName: 'BrainAtlas',
  webDir: 'dist',
  backgroundColor: '#000000',
  ios: {
    contentInset: 'never',
    backgroundColor: '#000000',
  },
  android: {
    backgroundColor: '#000000',
  },
  plugins: {
    StatusBar: {
      overlaysWebView: false,
      style: 'DARK',
      backgroundColor: '#000000',
    },
  },
};

export default config;
