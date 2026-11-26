// Local static server for site/ (ES modules do not load from file://).
// Listens on 127.0.0.1 only and never serves a path outside site/.
//   npm run site        -> http://localhost:5173/
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../site/', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

export function startSiteServer({ port = 5173, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    let path;
    try {
      path = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    if (path.endsWith('/')) path += 'index.html';
    const file = resolve(ROOT, `.${path}`);
    const type = TYPES[extname(file)];
    if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep) || !type) {
      res.writeHead(404).end('Not found');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  return new Promise((ready) => {
    server.listen(port, host, () => ready({
      port: server.address().port,
      host,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port, host } = await startSiteServer({ port: Number(process.env.PORT) || 5173 });
  console.log(`CreatorDigest test page: http://localhost:${port}/ (listening on ${host} only)`);
}
