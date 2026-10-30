import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const FIREBASE_ENV = ['API_KEY', 'AUTH_DOMAIN', 'PROJECT_ID', 'STORAGE_BUCKET', 'MESSAGING_SENDER_ID', 'APP_ID'];

// Tauri serves the UI from a fixed port in development.
export default defineConfig(({ mode }) => {
  // A build without these would give an app that can't start.
  const env = loadEnv(mode, process.cwd(), 'VITE_FIREBASE_');
  const missing = FIREBASE_ENV.map((k) => `VITE_FIREBASE_${k}`).filter((k) => !env[k]);
  if (missing.length) throw new Error(`Configurazione Firebase mancante in .env (vedi .env.example): ${missing.join(', ')}`);

  return {
    plugins: [react()],
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
      watch: { ignored: ['**/src-tauri/**'] },
    },
    envPrefix: ['VITE_', 'TAURI_ENV_'],
    build: {
      target: ['es2022', 'chrome105', 'safari15'],
      chunkSizeWarningLimit: 2000,
    },
  };
});
