import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base matches the GitHub Pages project path (see spec: Toolchain > Deployment)
export default defineConfig({
  base: '/route-maker-3d/',
  plugins: [react()],
});
