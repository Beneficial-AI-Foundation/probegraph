import { defineConfig } from 'vite';

/**
 * Vite config for building the web app for VS Code webview embedding.
 * 
 * Key differences from production config:
 * - Base path is './' (relative) instead of '/probegraph/' 
 * - Output goes to dist-vscode/
 * - Imported assets are bundled; index.html still loads Inter from Google Fonts
 */
// The webview CSP allows no remote origins, so the Google Fonts links would
// only produce CSP errors; --pg-font-sans falls back to the system font.
const dropRemoteFonts = {
  name: 'drop-remote-fonts',
  transformIndexHtml: (html) =>
    html.replace(/^\s*<link [^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\n/gm, ''),
};

export default defineConfig({
  root: '.',
  plugins: [dropRemoteFonts],
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

