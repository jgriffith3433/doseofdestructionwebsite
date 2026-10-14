import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

const root = process.cwd();

// Unity decompression-fallback builds use .unityweb and decompress in the loader.
// Serve those files unchanged, with no Content-Encoding header.
function serveRaw(extensions, contentType) {
  const rootResolved = path.resolve(root);

  return (req, res, next) => {
    const pathname = decodeURIComponent((req.url || '').split('?')[0]);
    if (!extensions.some((ext) => pathname.endsWith(ext))) {
      next();
      return;
    }

    const relativePath = pathname.replace(/^\/+/, '');
    const filePath = path.resolve(rootResolved, relativePath);
    const relative = path.relative(rootResolved, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      next();
      return;
    }

    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      next();
      return;
    }
    if (!stat.isFile()) {
      next();
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Cache-Control', 'no-cache');
    fs.createReadStream(filePath).pipe(res);
  };
}

export default defineConfig({
  base: './',
  appType: 'mpa',
  plugins: [
    {
      name: 'unity-webgl-static',
      configureServer(server) {
        server.middlewares.use(serveRaw(['.unityweb'], 'application/octet-stream'));
        server.middlewares.use(serveRaw(['.loader.js'], 'application/javascript; charset=utf-8'));
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    port: 8089,
    strictPort: true,
    watch: {
      ignored: ['**/*.unityweb'],
    },
  },
});
