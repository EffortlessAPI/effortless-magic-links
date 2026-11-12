// A look at the UI without a project: Dev mode against a throwaway database shaped like the
// seed's own tables, a stand-in generated API, and the project's server on a fixed port.
//   ML_TEST_PG=... node test/demo-server.mjs [port]     then open http://127.0.0.1:<port>/
import http from 'node:http';
import { dev } from './db.mjs';
import { loadConfigFrom } from './config-helper.mjs';
import { generatedApi, projectServer } from './harness.mjs';
import * as S from './schemas.mjs';

const db = await dev('demo', S.appUsers.sql, loadConfigFrom({}));
const api = await generatedApi(db.url);
const srv = await projectServer({ dbUrl: db.url, apiUrl: api.url, env: { MAGICLINK_MANAGED: 'effortless' } });
const port = Number(process.argv[2] || 4999);
const page = '<!doctype html><meta charset="utf-8"><title>Demo app</title><script type="module" src="/api/magic-links/ui/magic-links-ui.js"></script><ml-gate><main style="font:16px system-ui;padding:24px"><h1>The app</h1><p id="who"></p><a href="/api/magic-links/setup">Sign-in setup</a></main></ml-gate><script>document.addEventListener("ml-session",(e)=>{document.getElementById("who").textContent="Signed in: "+JSON.stringify(e.detail.user)})</script>';
http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('content-type', 'text/html'); return res.end(page); }
  const up = http.request({ host: '127.0.0.1', port: new URL(srv.base).port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  req.pipe(up);
}).listen(port, '127.0.0.1', () => console.log(`demo on http://127.0.0.1:${port}/`));
process.on('SIGTERM', async () => { await srv.close(); await api.close(); await db.drop(); process.exit(0); });
