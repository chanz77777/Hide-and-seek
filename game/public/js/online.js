// online.js — オンライン対戦（Vercel の API）。部屋の作成・参加・ロビー・ラウンド進行を担当する。
// サーバーの状態を約 1 秒ごとに取りに行き、変化に応じて main.js（window.__game）を操作する。
// 仕様: docs/online-protocol.md
(function () {
  'use strict';
  const G = window.__game;
  const $ = (id) => document.getElementById(id);
  if (!G || !/^https?:$/.test(location.protocol)) return;   // file:// で開いたときはローカル対戦のみ
  $('onlineBox').hidden = false;

  const POLL_MS = 1000;
  const POLL_SEEK_MS = 400;   // 捜索中は照準を見せるため速めに取りに行く
  const AIM_SEND_MS = 250;    // 見つける人が照準を送る間隔
  const SESSION_KEY = 'kakurenbo-session';
  let me = null;            // { code, playerId, token, name }
  let room = null, version = -1, pollTimer = 0, polling = false, bombBusy = false;
  let floorCache = { url: null, canvas: null };
  let lastCursorT = 0, aimTimer = 0, aimPending = null, aimLastSent = 0;
  const texCache = new Map();   // texUrl → Image

  // ---------- 通信 ----------
  async function api(path, opts) {
    let r;
    try { r = await fetch('/api/' + path, opts); } catch (_) { throw new Error('サーバーに接続できませんでした'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `通信エラー（${r.status}）`);
    return j;
  }
  const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  async function act(type, extra) {
    const j = await post('action', Object.assign({ code: me.code, playerId: me.playerId, token: me.token, type }, extra || {}));
    onRoom(j.room); return j;
  }
  async function upload(kind, blob) {
    const q = new URLSearchParams({ code: me.code, playerId: me.playerId, token: me.token, kind });
    let r;
    try { r = await fetch('/api/upload?' + q, { method: 'POST', headers: { 'content-type': blob.type }, body: blob }); }
    catch (_) { throw new Error('画像を送れませんでした'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `画像の送信に失敗しました（${r.status}）`);
    return j.url;
  }
  // キャンバスを 4 MB 以下の画像にする（WebP 優先、使えなければ JPEG）
  async function encode(cv) {
    const toBlob = (type, q) => new Promise(res => cv.toBlob(res, type, q));
    for (const q of [0.92, 0.8, 0.65, 0.5]) {
      let b = await toBlob('image/webp', q);
      if (!b || b.type !== 'image/webp') b = await toBlob('image/jpeg', q);
      if (b && b.size <= 4 * 1024 * 1024) return b;
    }
    throw new Error('画像が大きすぎます');
  }
  function loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => res(img); img.onerror = () => rej(new Error('画像を読み込めませんでした'));
      img.src = url;
    });
  }

  // ---------- セッション（再読み込みしても部屋に戻れるように） ----------
  function saveSession() { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(me)); } catch (_) {} }
  function loadSession() { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch (_) { return null; } }
  function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {} }
  try { const n = localStorage.getItem('kakurenbo-name'); if (n) $('nameInput').value = n; } catch (_) {}
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) $('codeInput').value = urlRoom.toUpperCase();

  // ---------- 部屋を作る / 参加する ----------
  function nameOrAsk() {
    const n = $('nameInput').value.trim();
    if (!n) { $('onlineMsg').textContent = '名前を入れてください'; $('nameInput').focus(); return null; }
    try { localStorage.setItem('kakurenbo-name', n); } catch (_) {}
    return n;
  }
  async function enter(fn) {
    $('onlineMsg').textContent = '接続しています…';
    try { await fn(); $('onlineMsg').textContent = ''; }
    catch (e) { $('onlineMsg').textContent = e.message; }
  }
  $('createRoomBtn').addEventListener('click', () => {
    const name = nameOrAsk(); if (!name) return;
    enter(async () => {
      const j = await post('create', { name });
      begin({ code: j.code, playerId: j.playerId, token: j.token, name }, j.room);
    });
  });
  $('joinRoomBtn').addEventListener('click', () => {
    const name = nameOrAsk(); if (!name) return;
    const code = $('codeInput').value.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) { $('onlineMsg').textContent = '部屋コードは英字 4 文字です'; return; }
    enter(async () => {
      const j = await post('join', { code, name });
      begin({ code, playerId: j.playerId, token: j.token, name }, j.room);
    });
  });

  function begin(session, r) {
    me = session; saveSession();
    history.replaceState(null, '', `${location.pathname}?room=${me.code}`);
    G.attachNet(netHandlers);
    $('titleOverlay').hidden = true;
    onRoom(r);
    startPolling();
  }
  function end(msg) {
    stopPolling(); clearSession(); G.detachNet();
    me = null; room = null; version = -1; floorCache = { url: null, canvas: null };
    $('lobbyOverlay').hidden = true; $('lobbyBackBtn').hidden = true;
    G.resetBombs(); G.resetToTitle();
    history.replaceState(null, '', location.pathname);
    if (msg) $('onlineMsg').textContent = msg;
  }

  // ---------- ポーリング ----------
  function startPolling() { stopPolling(); polling = true; poll(); }
  function stopPolling() { polling = false; clearTimeout(pollTimer); }
  async function poll() {
    if (!polling || !me) return;
    try {
      const q = new URLSearchParams({ code: me.code, playerId: me.playerId, v: String(version) });
      const j = await api('state?' + q);
      if (j.unchanged) G.setClockOffset(j.serverNow - Date.now());
      else if (j.room) onRoom(j.room);
      // 見つける人の照準（観戦している人の画面に出す）
      if (j.cursor && j.cursor.t !== lastCursorT && room && room.phase === 'seek' && !isSeeker()) {
        lastCursorT = j.cursor.t; G.setRemoteAim(j.cursor.x, j.cursor.z);
      }
    } catch (e) {
      if (/見つかりません|not found/i.test(e.message)) { end('部屋がなくなりました'); return; }
    }
    if (polling) pollTimer = setTimeout(poll, room && room.phase === 'seek' ? POLL_SEEK_MS : POLL_MS);
  }

  // ---------- 状態の反映 ----------
  const isHost = () => room && me && room.hostId === me.playerId;
  const isSeeker = () => room && me && room.seekerId === me.playerId;
  const myHider = () => room && me && (room.hiders || []).find(h => h.id === me.playerId);

  function onRoom(r) {
    if (!r || (room && r.version < room.version)) return;
    const prev = room; room = r; version = r.version;
    G.setClockOffset(r.serverNow - Date.now());
    if (!r.players.some(p => p.id === me.playerId)) { end('部屋から外れました'); return; }
    const entered = !prev || prev.phase !== r.phase || prev.round !== r.round;
    render(entered).catch(e => G.toast(e.message));
  }

  async function ensureFloor() {
    if (!room.floorUrl) return null;
    if (floorCache.url !== room.floorUrl) {
      const img = await loadImage(room.floorUrl);
      const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      cv.getContext('2d').drawImage(img, 0, 0);
      floorCache = { url: room.floorUrl, canvas: cv };
    }
    return floorCache.canvas;
  }

  async function render(entered) {
    $('lobbyOverlay').hidden = room.phase !== 'lobby';
    if (room.phase !== 'result') $('lobbyBackBtn').hidden = true;
    if (room.phase === 'lobby') return renderLobby(entered);
    if (room.phase === 'prep' && entered) return enterPrep();
    if (room.phase === 'seek') return renderSeek(entered);
    if (room.phase === 'result') return renderResult(entered);
  }

  // ----- ロビー -----
  async function renderLobby(entered) {
    if (entered) { G.resetBombs(); G.resetToTitle({ keepHidden: true }); G.setHud('none'); bombBusy = false; }
    $('roomCode').textContent = room.code;
    $('shareUrl').value = `${location.origin}${location.pathname}?room=${room.code}`;
    const host = isHost();
    $('hostControls').hidden = !host; $('startOnlineBtn').hidden = !host;
    $('playerList').innerHTML = '';
    room.players.forEach(p => {
      const li = document.createElement('li'); if (!p.online) li.className = 'off';
      const seeker = p.id === room.seekerId;
      li.innerHTML = `<span class="nm"></span><span class="role ${seeker ? 'seeker' : ''}">${seeker ? '見つける人' : '隠れる人'}</span>`;
      li.querySelector('.nm').textContent = (p.isHost ? '★ ' : '') + p.name + (p.id === me.playerId ? '（あなた）' : '') + (p.online ? '' : ' · 接続なし');
      if (host && !seeker) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'btn small'; b.textContent = '見つける人にする';
        b.addEventListener('click', () => act('set-seeker', { targetId: p.id }).catch(e => G.toast(e.message)));
        li.appendChild(b);
      }
      $('playerList').appendChild(li);
    });
    const ready = !!room.floorUrl && room.players.length >= 2;
    $('startOnlineBtn').disabled = !ready;
    $('lobbyMsg').textContent = !room.floorUrl
      ? (host ? '床の絵を選んでください（画像か自動生成）。' : 'ホストが床の絵を選ぶのを待っています。')
      : room.players.length < 2 ? '2 人以上集まると始められます。招待リンクを送ってください。'
      : host ? '準備ができたら「はじめる」を押してください。' : 'ホストが始めるのを待っています。';
    const cv = await ensureFloor().catch(() => null);
    const t = $('floorThumb').getContext('2d');
    t.fillStyle = '#e6e3da'; t.fillRect(0, 0, 160, 120);
    if (cv) { t.drawImage(cv, 0, 0, 160, 120); G.applyFloorCanvas(cv); }
  }

  async function setFloorFromCanvas(cv) {
    $('lobbyMsg').textContent = '床の絵を送っています…';
    try {
      const url = await upload('floor', await encode(cv));
      await act('set-floor', { url });
    } catch (e) { $('lobbyMsg').textContent = e.message; }
  }
  $('lobbyImgFile').addEventListener('change', (e) => {
    const f = e.target.files[0]; if (!f) return;
    const u = URL.createObjectURL(f), img = new Image();
    img.onload = () => { URL.revokeObjectURL(u); setFloorFromCanvas(G.cropToFloor(img)); };
    img.onerror = () => { URL.revokeObjectURL(u); G.toast('画像を読み込めませんでした'); };
    img.src = u; e.target.value = '';
  });
  $('lobbyGenBtn').addEventListener('click', () => {
    setFloorFromCanvas(Floor.generate({ seed: Math.floor(Math.random() * 90000) + 1000 }).canvas);
  });
  $('startOnlineBtn').addEventListener('click', () => {
    act('start', { prepSeconds: Number($('prepSel').value), seekSeconds: Number($('seekSel').value) })
      .catch(e => { $('lobbyMsg').textContent = e.message; });
  });
  $('copyBtn').addEventListener('click', () => {
    const v = $('shareUrl').value;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject())
      .then(() => G.toast('招待リンクをコピーしました'))
      .catch(() => { $('shareUrl').select(); G.toast('選択しました。コピーしてください'); });
  });
  $('leaveBtn').addEventListener('click', leave);
  async function leave() { try { await act('leave'); } catch (_) {} end(''); }

  // ----- 準備（隠れる / 待つ） -----
  async function enterPrep() {
    const cv = await ensureFloor();
    if (cv) G.applyFloorCanvas(cv);
    G.resetBombs();
    if (isSeeker()) { G.enterWaitOnline(room.prepEndsAt, room.prepSeconds); return; }
    if (myHider()) {
      // 全員が同じ場所から始まらないよう、床の内側のランダムな位置に置く
      G.startHiding({ endsAt: room.prepEndsAt, prepSeconds: room.prepSeconds,
        x: (Math.random() - 0.5) * 12, z: (Math.random() - 0.5) * 8, heading: Math.random() * Math.PI * 2 });
      return;
    }
    G.enterWaitOnline(room.prepEndsAt, room.prepSeconds);   // 途中参加: 次のラウンドから
    G.toast('このラウンドは観戦です。次のラウンドから参加できます');
  }

  // ----- 捜索 -----
  async function renderSeek(entered) {
    {
      if (entered || G.phase() !== 'seek') {
        const hiders = await Promise.all(room.hiders.map(async h => {
          let img = texCache.get(h.texUrl);
          if (!img) { img = await loadImage(h.texUrl); texCache.set(h.texUrl, img); }
          return { id: h.id, img, x: h.x, z: h.z, heading: h.heading };
        }));
        if (!isSeeker() && G.phase() === 'play') G.toast('時間内に送れなかったので、このラウンドは観戦です');
        // 見つける人も隠れる人も同じ真上の画面。隠れる人は観戦のみ（爆撃できない）
        G.startSeekOnline({ hiders, endsAt: room.seekEndsAt, seekSeconds: room.seekSeconds,
          bombsTotal: room.bombsTotal, bombsLeft: room.bombsLeft, spectator: !isSeeker() });
        // 入る前に落ちていた爆弾は演出なしで並べる
      }
      G.syncBombs(room, me.playerId);
    }
  }

  // ----- 結果 -----
  async function renderResult(entered) {
    G.syncBombs(room, me.playerId);
    const res = room.result || {}, host = isHost();
    const reasonText = { 'all-found': '全員見つかりました。', 'no-bombs': '爆弾がなくなりました。', timeout: '時間切れです。',
      'no-hiders': '誰も隠れられませんでした。', 'seeker-left': '見つける人が抜けました。' }[res.reason] || '';
    const summary = `${reasonText}発見 ${res.found || 0} / ${res.total || 0} 人。`;
    if (!(entered || G.phase() !== 'result')) return;
    const back = host ? 'ロビーに戻る' : 'ホストを待っています';
    if (isSeeker()) {
      const win = res.total > 0 && res.found === res.total;
      G.showSeekResult(win ? '全員見つけた！' : res.found ? `${res.found} 人見つけた` : '逃げ切られた…',
        summary + '黄色い輪が隠れていた場所です。', win || res.found > 0, back, host);
      return;
    }
    const mine = myHider();
    if (mine && !mine.found) G.cutin('逃げ切った！', 'win');
    G.showSeekResult(!mine ? '結果' : mine.found ? '見つかった…' : '逃げ切った！',
      summary + '黄色い輪が隠れていた場所です。', !!mine && !mine.found, back, host);
  }
  $('lobbyBackBtn').addEventListener('click', () => act('to-lobby').catch(e => G.toast(e.message)));

  // ---------- main.js からの呼び出し ----------
  const netHandlers = {
    async onHidden() {
      try {
        const texUrl = await upload('body', await encode(G.makeAtlas()));
        const pose = G.pose();
        await act('hidden', { x: pose.x, z: pose.z, heading: pose.heading, texUrl, outline: G.outlinePoints() });
        if (room.phase === 'prep') G.hiddenSent('送信しました。ほかの人の準備を待っています…');
      } catch (e) { G.hiddenSent('送信に失敗しました: ' + e.message); }
    },
    onBomb(x, z) {
      if (bombBusy) return;
      bombBusy = true;
      act('bomb', { x, z }).catch(e => G.toast(e.message)).finally(() => { bombBusy = false; });
    },
    // 照準は間引いて送る（最後の位置は必ず届ける）
    onAim(x, z) {
      aimPending = { x, z };
      const wait = AIM_SEND_MS - (Date.now() - aimLastSent);
      if (aimTimer) return;
      aimTimer = setTimeout(() => {
        aimTimer = 0; aimLastSent = Date.now();
        const p = aimPending; aimPending = null;
        if (p && room && room.phase === 'seek') post('cursor', { code: me.code, playerId: me.playerId, token: me.token, x: p.x, z: p.z }).catch(() => {});
      }, Math.max(0, wait));
    },
    onResultBack() { if (isHost()) act('to-lobby').catch(e => G.toast(e.message)); },
    onLeave: leave,
  };

  // ---------- 再読み込み時の復帰 ----------
  const saved = loadSession();
  if (saved && (!urlRoom || urlRoom.toUpperCase() === saved.code)) {
    me = saved;
    api('state?' + new URLSearchParams({ code: saved.code, playerId: saved.playerId, v: '-1' }))
      .then(j => { if (j.room && j.room.players.some(p => p.id === saved.playerId)) begin(saved, j.room); else clearSession(); })
      .catch(() => { clearSession(); me = null; });
  }

  // 自動テスト用
  window.kakurenboOnline = { state: () => ({ me, room }) };
})();
