// node apps-script/dev/serve.mjs [port]。重開程序會重建記憶體裡的假資料。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { makeGas, mail, TEACHER } from './gasfake.mjs';
import { ROSTER, seed } from './seed.mjs';

const port = Number(process.argv[2] || 8918);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('通訊埠須介於 1–65535');

const host = '127.0.0.1';
const serviceUrl = `http://${host}:${port}/`;
const localHosts = new Set([`${host}:${port}`, `localhost:${port}`]);
const defaultUser = mail(ROSTER[0].sid);
const shim = readFileSync(new URL('./shim.js', import.meta.url), 'utf8');
const gas = makeGas({ serviceUrl });
seed(gas);

const rpcFunctions = new Set([
  'checkInByCode', 'teacherBoot', 'saveGradeFolder', 'startSession', 'teacherTick',
  'extendSession', 'closeSession', 'sessionRoster', 'teacherMark', 'applyTopUp',
  'createDemoBook', 'setup', 'clearTestSessions',
]);

function send(res, code, contentType, body) {
  res.writeHead(code, {
    'content-type': `${contentType}; charset=utf-8`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

function sendJson(res, code, data) {
  send(res, code, 'application/json', JSON.stringify(data));
}

async function handleRpc(req, res) {
  const { origin } = req.headers;
  if (origin && origin !== `http://${req.headers.host}`) {
    return sendJson(res, 403, { ok: false, error: '預覽只接受本機頁面的請求' });
  }
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    return sendJson(res, 415, { ok: false, error: '請使用 JSON' });
  }

  const maxBytes = 16 * 1024;
  let received = 0;
  const chunks = [];
  for await (const chunk of req) {
    received += chunk.length;
    if (received <= maxBytes) chunks.push(chunk);
  }
  if (received > maxBytes) return sendJson(res, 413, { ok: false, error: '請求過大' });

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return sendJson(res, 400, { ok: false, error: 'JSON 格式錯誤' });
  }
  const { fn, args = [], user = defaultUser } = input ?? {};
  if (typeof user !== 'string' || !Array.isArray(args)) {
    return sendJson(res, 400, { ok: false, error: '請求參數格式錯誤' });
  }
  if (!rpcFunctions.has(fn)) {
    return sendJson(res, 403, { ok: false, error: '這個 Apps Script 函式未開放給瀏覽器' });
  }
  try {
    return sendJson(res, 200, { ok: true, result: gas.as(user).call(fn, ...args) });
  } catch (error) {
    return sendJson(res, 200, { ok: false, error: error.message });
  }
}

async function handleRequest(req, res) {
  if (!localHosts.has(req.headers.host)) return send(res, 403, 'text/plain', '預覽只接受本機連線');
  const url = new URL(req.url, serviceUrl);
  if (req.method === 'POST' && url.pathname === '/rpc') return handleRpc(req, res);
  if (req.method === 'GET' && url.pathname === '/') {
    const params = Object.fromEntries(url.searchParams);
    const html = gas.as(url.searchParams.get('user') ?? defaultUser).page(params);
    const preview = html.replace(/<head\b[^>]*>/i, (head) => `${head}\n<script>\n${shim}\n</script>`);
    return send(res, 200, 'text/html', preview);
  }
  return send(res, 404, 'text/plain', '找不到預覽頁面');
}

http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent && !res.destroyed) send(res, 500, 'text/plain', '本機預覽發生錯誤');
  });
}).listen(port, host, () => {
  console.log(`課堂點名本機預覽 ${serviceUrl}?user=${encodeURIComponent(TEACHER)}`);
});
