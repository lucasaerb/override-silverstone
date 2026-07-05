/**
 * Minimal zero-dependency static file server for the production build.
 *
 * The game itself needs no backend — multiplayer is peer-to-peer (WebRTC /
 * BroadcastChannel), so this process only ships the built `dist/` assets to the
 * browser once. It listens on Railway's injected $PORT.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('./dist/', import.meta.url));
const PORT = process.env.PORT || 3000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

const server = createServer(async (req, res) => {
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel.endsWith('/')) rel += 'index.html';

  // resolve within dist and reject any path traversal
  let filePath = join(DIST, rel);
  if (!filePath.startsWith(DIST)) { res.writeHead(403); res.end('forbidden'); return; }

  let data;
  try {
    data = await readFile(filePath);
  } catch {
    filePath = join(DIST, 'index.html'); // single-page fallback
    try { data = await readFile(filePath); }
    catch { res.writeHead(404); res.end('not found'); return; }
  }

  const ext = extname(filePath);
  res.setHeader('Content-Type', TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', rel.includes('/assets/') && ext !== '.html'
    ? 'public, max-age=31536000, immutable' // hashed build assets
    : 'no-cache');
  res.writeHead(200);
  res.end(data);
});

server.listen(PORT, '0.0.0.0', () => console.log(`OVERRIDE: Silverstone serving dist/ on :${PORT}`));
