import { defineConfig } from 'vite';

/**
 * Vite config for building the web app for VS Code webview embedding.
 * 
 * Key differences from production config:
 * - Base path is './' (relative) instead of '/probegraph/' 
 * - Output goes to dist-vscode/
 * - Imported assets are bundled; index.html still loads Inter from Google Fonts
 */
export default defineConfig({
  root: '.',
  base: './',  // Relative paths for webview
  publicDir: false,  // Don't copy public folder (graph.json not needed)
  build: {
    outDir: 'dist-vscode',
    emptyOutDir: true,
    // Inline all assets for easier webview loading
    assetsInlineLimit: 100000,  // 100KB - inline most assets
    rollupOptions: {
      input: {
        main: './index.html'
      },
      output: {
        // Use predictable names for easier loading
        entryFileNames: 'assets/main.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]'
      }
    }
  }
});

