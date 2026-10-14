// ローカル開発用サーバー（依存なし）。public/ の静的配信 + /uploads/* + /api/<name> → api/<name>.js
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = path.join(ROOT, 'dev', '.data', 'uploads');
const API_DIR = path.join(ROOT, 'api');
const MAX_BODY = 6 * 1024 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

/** base 配下のファイルに解決する。外に出るなら null */
function safeJoin(base, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const file = path.resolve(base, '.' + path.posix.normalize('/' + decoded));
  if (file !== base && !file.startsWith(base + path.sep)) return null;
  return file;
}

async function serveFile(res, base, urlPath) {
  let file = safeJoin(base, urlPath);
  if (!file) return send(res, 400, 'Bad path');
  try {
    let st = await stat(file);
    if (st.isDirectory()) {
      file = path.join(file, 'index.html');
      st = await stat(file);
    }
    if (!st.isFile()) return send(res, 404, 'Not found');
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    createReadStream(file).pipe(res);
  } catch {
    send(res, 404, 'Not found');
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveApi(req, res, name, url) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return send(res, 404, JSON.stringify({ error: 'API が見つかりません' }), 'application/json; charset=utf-8');
  const file = path.join(API_DIR, name + '.js');
  try {
    await stat(file);
  } catch {
    return send(res, 404, JSON.stringify({ error: 'API が見つかりません' }), 'application/json; charset=utf-8');
  }
  const mod = await import(pathToFileURL(file).href);
  const handler = mod[req.method];
  if (typeof handler !== 'function') {
    return send(res, 405, JSON.stringify({ error: '使えないメソッドです' }), 'application/json; charset=utf-8');
  }
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v != null) headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await readBody(req);
  const response = await handler(new Request(url.href, init));
  const outHeaders = {};
  response.headers.forEach((v, k) => (outHeaders[k] = v));
  const buf = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, outHeaders);
  res.end(buf);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const started = Date.now();
    res.on('finish', () => {
      if (process.env.DEV_SERVER_QUIET) return;
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    });
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const p = url.pathname;
      if (p.startsWith('/api/')) return await serveApi(req, res, p.slice(5), url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      if (p.startsWith('/uploads/')) return await serveFile(res, UPLOAD_DIR, p.slice('/uploads'.length));
      return await serveFile(res, PUBLIC_DIR, p);
    } catch (err) {
      if (err && err.status === 413) return send(res, 413, JSON.stringify({ error: '送信データが大きすぎます' }), 'application/json; charset=utf-8');
      console.error(err);
      if (!res.headersSent) send(res, 500, 'Internal error');
      else res.end();
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, () => {
    console.log(`dev server: http://localhost:${port}/`);
  });
}
