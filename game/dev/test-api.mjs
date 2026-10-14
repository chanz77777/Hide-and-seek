// エンドツーエンドのテスト。dev サーバーを空きポートで起動し、HTTP で一通り遊ぶ。
// 実行: npm test
for (const k of ['KV_REST_API_URL', 'KV_REST_API_TOKEN', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'BLOB_READ_WRITE_TOKEN']) {
  delete process.env[k]; // 必ずメモリ保存・ローカル保存で動かす
}
process.env.DEV_SERVER_QUIET ||= '1';

const { createServer } = await import('./server.mjs');

let pass = 0;
let failCount = 0;
function check(label, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    failCount++;
    console.log(`FAIL  ${label}${extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 300) : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = createServer();
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
console.log(`test server: ${BASE}`);

async function call(method, path, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (body instanceof Uint8Array) init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
  }
  const res = await fetch(BASE + path, init);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}
const post = (path, body, headers) => call('POST', path, body, headers);
const get = (path) => call('GET', path);

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const square = (cx, cz, r = 0.15) => {
  const pts = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return pts;
};

async function main() {
  // ---------- static ----------
  const idx = await fetch(BASE + '/');
  check('GET / serves index.html', idx.status === 200 && (idx.headers.get('content-type') || '').startsWith('text/html'));
  await idx.text();
  const js = await fetch(BASE + '/js/main.js');
  check('GET /js/main.js has JS content type', js.status === 200 && (js.headers.get('content-type') || '').includes('javascript'));
  await js.text();
  const trav = await fetch(BASE + '/uploads/..%2f..%2fpackage.json');
  check('path traversal under /uploads is blocked', trav.status === 400 || trav.status === 404, trav.status);
  await trav.text();
  const trav2 = await fetch(BASE + '/%2e%2e/package.json');
  check('path traversal under / is blocked', trav2.status === 400 || trav2.status === 404, trav2.status);
  await trav2.text();
  const noApi = await get('/api/nope');
  check('unknown API → 404', noApi.status === 404);

  // ---------- create / join ----------
  let r = await post('/api/create', { name: '  ' });
  check('create with blank name → 400', r.status === 400 && typeof r.data.error === 'string', r.data);
  r = await post('/api/create', { name: 'あいうえおかきくけこさしすせそたち' });
  check('create with 17-char name → 400', r.status === 400, r.data);

  r = await post('/api/create', { name: ' ホストA ' });
  check('create room', r.status === 200 && /^[A-HJ-NP-Z]{4}$/.test(r.data.code), r.data);
  check('API sends Cache-Control: no-store', r.headers.get('cache-control') === 'no-store');
  const code = r.data.code;
  const A = { id: r.data.playerId, token: r.data.token };
  check('playerId 12 chars / token 24 chars', A.id.length === 12 && A.token.length === 24);
  check('name trimmed', r.data.room.players[0].name === 'ホストA');
  check('creator is host and seeker', r.data.room.hostId === A.id && r.data.room.seekerId === A.id && r.data.room.players[0].isHost);
  check('public room has no tokens', !JSON.stringify(r.data.room).includes(A.token));

  r = await post('/api/join', { code: 'ZZZZ', name: 'x' });
  check('join unknown room → 404', r.status === 404, r.data);
  r = await post('/api/join', { code: code.toLowerCase(), name: 'B' });
  check('join B (lowercase code ok)', r.status === 200 && r.data.room.players.length === 2, r.data);
  const B = { id: r.data.playerId, token: r.data.token };
  r = await post('/api/join', { code, name: 'C' });
  check('join C', r.status === 200 && r.data.room.players.length === 3);
  const C = { id: r.data.playerId, token: r.data.token };

  const act = (p, type, extra = {}) => post('/api/action', { code, playerId: p.id, token: p.token, type, ...extra });

  // ---------- error cases ----------
  r = await post('/api/action', { code, playerId: A.id, token: 'x'.repeat(24), type: 'set-seeker', targetId: B.id });
  check('wrong token → 403', r.status === 403 && r.data.error, r.data);
  r = await act(B, 'start');
  check('start by non-host → 403', r.status === 403, r.data);
  r = await act(A, 'start');
  check('start without floor → 409', r.status === 409, r.data);
  r = await act(A, 'set-floor', { url: 'http://evil.example/a.png' });
  check('set-floor with non-https url → 400', r.status === 400, r.data);
  r = await act(A, 'bogus');
  check('unknown action → 400', r.status === 400, r.data);

  // ---------- upload ----------
  const up = (p, kind, body, type = 'image/png') =>
    post(`/api/upload?code=${code}&playerId=${p.id}&token=${p.token}&kind=${kind}`, body, { 'Content-Type': type });
  r = await up(B, 'floor', PNG);
  check('floor upload by non-host → 403', r.status === 403, r.data);
  r = await up(A, 'floor', PNG, 'image/gif');
  check('upload with bad content-type → 415', r.status === 415, r.data);
  r = await up(A, 'floor', Buffer.from('not a png at all'));
  check('upload with wrong magic bytes → 415', r.status === 415, r.data);
  r = await up(A, 'floor', Buffer.alloc(4 * 1024 * 1024 + 1, 0x89));
  check('upload over 4 MB → 413', r.status === 413, r.data);
  r = await post(`/api/upload?code=${code}&playerId=${A.id}&token=bad&kind=floor`, PNG, { 'Content-Type': 'image/png' });
  check('upload with wrong token → 403', r.status === 403, r.data);
  r = await up(A, 'floor', PNG);
  const floorUrl = r.data.url;
  check('floor upload by host', r.status === 200 && /^\/uploads\/rooms\/[A-Z]{4}\/floor-.+\.png$/.test(floorUrl || ''), r.data);
  const img = await fetch(BASE + floorUrl);
  const imgBuf = Buffer.from(await img.arrayBuffer());
  check('uploaded file is served with image/png', img.status === 200 && img.headers.get('content-type') === 'image/png' && imgBuf.equals(PNG));
  r = await up(C, 'body', PNG);
  check('body upload by non-host', r.status === 200 && r.data.url.includes('/body-'), r.data);
  const texC = r.data.url;
  r = await up(A, 'body', PNG);
  const texA = r.data.url;

  // ---------- lobby setup ----------
  r = await act(A, 'set-floor', { url: floorUrl });
  check('set-floor', r.status === 200 && r.data.room.floorUrl === floorUrl, r.data);
  r = await act(A, 'set-seeker', { targetId: 'nobody' });
  check('set-seeker unknown target → 400', r.status === 400, r.data);
  r = await act(A, 'set-seeker', { targetId: B.id });
  check('set-seeker B', r.status === 200 && r.data.room.seekerId === B.id && r.data.room.players.find((p) => p.id === B.id).role === 'seeker');
  r = await act(A, 'start', { prepSeconds: 5, seekSeconds: 10 });
  check('start with prepSeconds 5 (out of range) → 400', r.status === 400, r.data);
  r = await act(A, 'start', { prepSeconds: 10, seekSeconds: 10 });
  check('start → prep', r.status === 200 && r.data.room.phase === 'prep' && r.data.room.round === 1, r.data);
  let room = r.data.room;
  check('hiders are A and C', room.hiders.length === 2 && room.hiders.every((h) => h.id === A.id || h.id === C.id));
  check('prepEndsAt ≈ now + 10 s', Math.abs(room.prepEndsAt - room.serverNow - 10000) < 1000, room);

  // ---------- prep ----------
  r = await act(B, 'hidden', { x: 0, z: 0, heading: 0, texUrl: texA, outline: square(0, 0) });
  check('seeker cannot send hidden → 403', r.status === 403, r.data);
  r = await act(A, 'hidden', { x: 20, z: 0, heading: 0, texUrl: texA, outline: square(0, 0) });
  check('hidden with x out of range → 400', r.status === 400, r.data);
  r = await act(A, 'hidden', { x: 1, z: 1, heading: 0, texUrl: texA, outline: Array.from({ length: 601 }, () => [0, 0]) });
  check('hidden with 601 outline points → 400', r.status === 400, r.data);
  r = await act(A, 'hidden', { x: 1, z: 1, heading: 0, texUrl: texA, outline: [[0, 'a']] });
  check('hidden with bad outline point → 400', r.status === 400, r.data);
  r = await act(A, 'hidden', { x: 2, z: 1, heading: 0.5, texUrl: texA, outline: square(2, 1) });
  check('A hidden', r.status === 200 && r.data.room.phase === 'prep', r.data);
  r = await act(A, 'hidden', { x: 2, z: 2, heading: 0.6, texUrl: texA, outline: square(2, 2) });
  check('A can overwrite hidden during prep', r.status === 200 && r.data.room.phase === 'prep');
  r = await get(`/api/state?code=${code}&playerId=${B.id}`);
  room = r.data.room;
  const hA = room.hiders.find((h) => h.id === A.id);
  check('during prep: A submitted but x/z/heading/texUrl hidden', hA.submitted === true && !('x' in hA) && !('z' in hA) && !('heading' in hA) && !('texUrl' in hA), hA);
  check('outline never exposed', !JSON.stringify(room).includes('outline'));
  r = await get(`/api/state?code=${code}&playerId=${B.id}&v=${room.version}`);
  check('state with same version → unchanged', r.data.unchanged === true && typeof r.data.serverNow === 'number' && !r.data.room, r.data);
  r = await get(`/api/state?code=${code}&v=${room.version - 1}`);
  check('state with old version → room', r.data.room && r.data.room.version === room.version);
  check('online flag true for recent pollers', r.data.room.players.every((p) => p.online === true), r.data.room.players);

  r = await act(C, 'hidden', { x: -5, z: -4, heading: 1, texUrl: texC, outline: square(-5, -4) });
  room = r.data.room;
  check('auto transition to seek after all hidden', r.status === 200 && room.phase === 'seek', room);
  check('bombsTotal = 6, bombsLeft = 6', room.bombsTotal === 6 && room.bombsLeft === 6, room);
  check('seekEndsAt ≈ now + 10 s', Math.abs(room.seekEndsAt - room.serverNow - 10000) < 1000);
  const sA = room.hiders.find((h) => h.id === A.id);
  check('during seek: positions exposed', sA.x === 2 && sA.z === 2 && sA.heading === 0.6 && sA.texUrl === texA, sA);
  check('outline still not exposed in seek', !JSON.stringify(room).includes('outline'));

  // ---------- cursor（見つける人の照準の共有） ----------
  r = await post('/api/cursor', { code, playerId: A.id, token: A.token, x: 1, z: 1 });
  check('non-seeker cursor → 409', r.status === 409, r.data);
  r = await post('/api/cursor', { code, playerId: B.id, token: 'wrong', x: 1, z: 1 });
  check('cursor with wrong token → 403', r.status === 403, r.data);
  r = await post('/api/cursor', { code, playerId: B.id, token: B.token, x: 99, z: 1 });
  check('cursor out of range → 400', r.status === 400, r.data);
  r = await post('/api/cursor', { code, playerId: B.id, token: B.token, x: 1.5, z: -2.25 });
  check('seeker cursor accepted', r.status === 200 && r.data.ok === true, r.data);
  r = await get(`/api/state?code=${code}&playerId=${C.id}&v=${room.version}`);
  check('cursor returned with unchanged state', r.data.unchanged === true && r.data.cursor && r.data.cursor.x === 1.5 && r.data.cursor.z === -2.25, r.data);

  // ---------- seek ----------
  r = await act(A, 'bomb', { x: 2, z: 2 });
  check('non-seeker bomb → 403', r.status === 403, r.data);
  r = await act(B, 'bomb', { x: 6, z: 5 });
  check('seeker bomb miss', r.status === 200 && r.data.room.bombs.length === 1 && r.data.room.bombs[0].hit === false && r.data.room.bombsLeft === 5, r.data);
  // A の輪郭の端（2.15, 2）から 0.18 → 中心からは 0.33 だが輪郭点が半径内なので命中
  r = await act(B, 'bomb', { x: 2.33, z: 2 });
  room = r.data.room;
  check('seeker bomb hits A via outline point', r.status === 200 && room.bombs[1].hit === true && room.bombs[1].hitIds.join() === A.id, room.bombs);
  check('A found, C not found', room.hiders.find((h) => h.id === A.id).found === true && room.hiders.find((h) => h.id === C.id).found === false);
  check('still seek', room.phase === 'seek' && room.bombsLeft === 4);
  r = await act(A, 'to-lobby');
  check('to-lobby during seek → 409', r.status === 409, r.data);
  for (let i = 0; i < 4; i++) r = await act(B, 'bomb', { x: 7, z: -5 + i * 0.1 });
  room = r.data.room;
  check('bombing until empty → result no-bombs', room.phase === 'result' && room.result && room.result.reason === 'no-bombs' && room.result.found === 1 && room.result.total === 2, room.result);
  check('positions exposed in result', 'x' in room.hiders[0] && 'texUrl' in room.hiders[0]);
  r = await act(B, 'bomb', { x: 0, z: 0 });
  check('bomb after result → 409', r.status === 409, r.data);
  r = await act(B, 'to-lobby');
  check('to-lobby by non-host → 403', r.status === 403);
  r = await act(A, 'to-lobby');
  room = r.data.room;
  check('to-lobby', r.status === 200 && room.phase === 'lobby' && room.hiders.length === 0 && room.bombs.length === 0 && room.result === null && room.seekerId === B.id && room.floorUrl === floorUrl && room.players.length === 3, room);

  // ---------- round 2: prep timeout + seek timeout ----------
  r = await act(A, 'start', { prepSeconds: 10, seekSeconds: 10 });
  check('round 2 start', r.status === 200 && r.data.room.round === 2 && r.data.room.phase === 'prep');
  const prepEndsAt = r.data.room.prepEndsAt;
  r = await act(A, 'hidden', { x: 0, z: 0, heading: 0, texUrl: texA, outline: square(0, 0) });
  check('only A hides', r.status === 200 && r.data.room.phase === 'prep');
  r = await post('/api/join', { code, name: 'D' });
  const D = { id: r.data.playerId, token: r.data.token };
  check('D joins during prep: player but not a hider this round', r.status === 200 && r.data.room.players.length === 4 && !r.data.room.hiders.some((h) => h.id === D.id));
  r = await act(D, 'hidden', { x: 0, z: 0, heading: 0, texUrl: texA, outline: square(0, 0) });
  check('late joiner cannot hide this round → 403', r.status === 403, r.data);

  await sleep(prepEndsAt - Date.now() + 1500);
  r = await get(`/api/state?code=${code}&playerId=${A.id}`);
  check('still prep within 3 s grace after prepEndsAt', r.data.room.phase === 'prep', r.data.room.phase);
  await sleep(prepEndsAt + 3000 - Date.now() + 300);
  r = await get(`/api/state?code=${code}&playerId=${A.id}`);
  room = r.data.room;
  check('prep timeout → seek', room.phase === 'seek', room.phase);
  check('C (never submitted) dropped from hiders', room.hiders.length === 1 && room.hiders[0].id === A.id, room.hiders);
  check('bombsTotal = 3', room.bombsTotal === 3 && room.bombsLeft === 3);

  r = await act(B, 'bomb', { x: 5, z: 5 });
  check('round 2 miss', r.status === 200 && r.data.room.bombsLeft === 2);
  await sleep(room.seekEndsAt - Date.now() + 300);
  r = await get(`/api/state?code=${code}&playerId=${A.id}`);
  room = r.data.room;
  check('seek timeout → result timeout', room.phase === 'result' && room.result.reason === 'timeout' && room.result.found === 0 && room.result.total === 1, room.result);

  // ---------- leave ----------
  r = await act(A, 'leave');
  room = r.data.room;
  check('host A leaves → next player (B) becomes host', r.status === 200 && room.hostId === B.id && room.players.length === 3 && !room.players.some((p) => p.id === A.id), room);
  r = await act(A, 'set-floor', { url: floorUrl });
  check('left player cannot act → 403', r.status === 403);
  r = await act(B, 'to-lobby');
  r = await act(B, 'set-seeker', { targetId: C.id });
  r = await act(B, 'start', { prepSeconds: 10, seekSeconds: 10 });
  check('round 3 start (seeker C)', r.status === 200 && r.data.room.phase === 'prep' && r.data.room.seekerId === C.id, r.data);
  r = await act(C, 'leave');
  room = r.data.room;
  check('seeker leaves during prep → result seeker-left', room.phase === 'result' && room.result.reason === 'seeker-left', room.result);
}

const started = Date.now();
try {
  await main();
} catch (err) {
  failCount++;
  console.log('FAIL  unexpected exception: ' + (err && err.stack));
} finally {
  server.close();
}
console.log(`\n${pass} PASS, ${failCount} FAIL  (${((Date.now() - started) / 1000).toFixed(1)} s)`);
process.exit(failCount ? 1 : 0);
