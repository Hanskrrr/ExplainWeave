import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const output = await mkdtemp(resolve(tmpdir(), 'explainweave-browser-'));
await build({
  entryPoints: [resolve(root, 'tests/browser/fixture.tsx')],
  outfile: resolve(output, 'app.js'),
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', jsx: 'automatic',
  sourcemap: true,
  nodePaths: [resolve(root, 'apps/obsidian/node_modules')],
});
const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ExplainWeave integration fixture</title><link rel="stylesheet" href="/app.css"></head><body><div class="fixture-note">集成测试预览 · 内存文件系统 · 不读取 Vault</div><div id="root"></div><script type="module" src="/app.js"></script></body></html>';
const allowed = new Set(['/app.js', '/app.css', '/app.js.map', '/app.css.map']);
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
  if (pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(html); return; }
  if (!allowed.has(pathname)) { response.writeHead(404); response.end(); return; }
  try {
    const content = await readFile(resolve(output, pathname.slice(1)));
    response.writeHead(200, { 'Content-Type': pathname.endsWith('.css') ? 'text/css' : 'text/javascript' });
    response.end(content);
  } catch { response.writeHead(404); response.end(); }
});
const port = Number(process.env.EXPLAINWEAVE_BROWSER_PORT ?? '4177');
server.listen(port, '127.0.0.1', () => process.stdout.write(`ExplainWeave fixture: http://127.0.0.1:${port}\n`));
async function close() { server.close(); await rm(output, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', close);
process.on('SIGTERM', close);
