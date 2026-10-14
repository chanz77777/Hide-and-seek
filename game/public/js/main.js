// お絵描きかくれんぼ — 隠れる人（ステップ 1）と見つける人（ステップ 2）
// 床生成 (floor.js)・ペイント (paint.js)・タブ連携 (link.js) を組み合わせ、移動・カメラ・ミニマップ・タイマー・爆撃・画面遷移を担当する。
(function () {
  'use strict';
  const WORLD_W = 16, WORLD_H = 12;        // 床のサイズ（unit。身長 = 2 unit）
  const PREP_SECONDS = 90;                 // 準備時間
  const PLAYER_SCALE = 0.25;               // 人の大きさ（1 = 身長 2 unit）
  const MOVE_SPEED = 1.2, ROT_SPEED = Math.PI / 2;
  const MARGIN = 1.1 * PLAYER_SCALE;       // 床の端からの余白（寝転んだ体の半分の長さ）
  const CAMO_SAT = 0.8;                    // 一括擬態の彩度（1 = 床と同じ、小さいほど色あせる）
  const CAMO_LIGHT = 0.05;                 // 一括擬態で白に寄せる割合（0 = そのまま）
  const CAMO_BLOCK = 0.04;                 // 一括擬態のモザイクの一辺（unit）。大きいほど粗い
  const SEEK_SECONDS = 60;                 // 見つける人の制限時間
  const HIDERS = 1;                        // ローカル対戦の隠れる人の人数（オンラインはサーバーが決める）
  const BOMBS = HIDERS * 3;                // ローカル対戦の爆弾の数
  const BOMB_RADIUS = 0.2;                 // 爆風の半径（unit）。寝転んだ体の長さは約 0.5
  const SHADE_START = 1 / 3;               // 制限時間のこの割合が過ぎたら影・ツヤを出し始め、終了時に 100%
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');

  if (!window.THREE || !window.Floor || !window.Paint || !window.Link) {
    $('loadMsg').textContent = 'スクリプトの読み込みに失敗しました（Three.js / floor.js / paint.js / link.js）。';
    return;
  }

  // ---------- renderer / scene ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = 'gl';
  stage.appendChild(renderer.domElement);
  const canvas = renderer.domElement;
  const maxAniso = renderer.capabilities.getMaxAnisotropy();

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1f2228);
  // ライトは人の「陰影・ツヤ」用。床は素の色で描くので影響しない
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a9aa6, 0.7));
  const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(6, 12, 8); scene.add(sun);
  const fillL = new THREE.DirectionalLight(0xffffff, 0.3); fillL.position.set(-8, 6, -6); scene.add(fillL);

  // 床（テクスチャは後から差し替える）
  const floorMat = new THREE.MeshBasicMaterial({ color: 0xffffff });   // ライティングなし = テクスチャの色そのまま
  const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W, WORLD_H), floorMat);
  floorMesh.rotation.x = -Math.PI / 2; floorMesh.visible = false; scene.add(floorMesh);   // 床の絵が決まるまで非表示
  const rim = new THREE.Mesh(new THREE.PlaneGeometry(WORLD_W + 0.6, WORLD_H + 0.6), new THREE.MeshBasicMaterial({ color: 0x111318 }));
  rim.rotation.x = -Math.PI / 2; rim.position.y = -0.01; scene.add(rim);

  let floorCanvas = null, floorData = null;   // floorData: 色の読み取り用 ImageData（遅延取得）
  function getFloorData() {
    if (!floorData) floorData = floorCanvas.getContext('2d').getImageData(0, 0, floorCanvas.width, floorCanvas.height);
    return floorData;
  }
  // 床上の座標 (x, z) の色を返す [r, g, b]
  function sampleFloor(x, z) {
    const d = getFloorData();
    const px = clamp(Math.floor((x / WORLD_W + 0.5) * d.width), 0, d.width - 1);
    const py = clamp(Math.floor((z / WORLD_H + 0.5) * d.height), 0, d.height - 1);
    const i = (py * d.width + px) * 4;
    return [d.data[i], d.data[i + 1], d.data[i + 2]];
  }
  let seed = Math.floor(Math.random() * 90000) + 1000;
  const mmCache = document.createElement('canvas'); mmCache.width = 440; mmCache.height = 330;
  // 床のテクスチャを差し替える（自動生成・画像取り込み共通）
  function applyFloorCanvas(cv) {
    floorCanvas = cv; floorData = null;
    if (floorMat.map) floorMat.map.dispose();
    const tex = new THREE.CanvasTexture(floorCanvas);
    tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = maxAniso;
    floorMat.map = tex; floorMat.needsUpdate = true; floorMesh.visible = true;
    mmCache.getContext('2d').drawImage(floorCanvas, 0, 0, mmCache.width, mmCache.height);
  }
  function buildFloor(s) {
    seed = s;
    const t0 = performance.now();
    applyFloorCanvas(Floor.generate({ seed: s, worldW: WORLD_W, worldH: WORLD_H }).canvas);
    $('seedInput').value = s;
    $('loadMsg').textContent = `床 #${s}（${Math.round(performance.now() - t0)} ms で生成）`;
  }

  // ---------- 画像の取り込み: 床の比率に中央で切り抜く ----------
  let floorSource = 'gen';          // gen | img
  let imageCanvas = null;           // 取り込み済みの画像（切り抜き後）
  function setFloorSource(src) {
    floorSource = src;
    $('srcGen').setAttribute('aria-pressed', String(src === 'gen'));
    $('srcImg').setAttribute('aria-pressed', String(src === 'img'));
    $('genRow').hidden = src !== 'gen'; $('imgRow').hidden = src !== 'img';
    if (src === 'gen') { buildFloor(seed); $('startBtn').disabled = false; }
    else if (imageCanvas) { applyFloorCanvas(imageCanvas); $('startBtn').disabled = false; }
    else { $('startBtn').disabled = true; $('loadMsg').textContent = '画像を選ぶと床になります'; }
  }
  function cropToFloor(img) {
    const sw = img.naturalWidth || img.width, sh = img.naturalHeight || img.height;
    const target = WORLD_W / WORLD_H;
    let cw = sw, ch = sh;
    if (sw / sh > target) cw = Math.round(sh * target); else ch = Math.round(sw / target);
    const sx = Math.round((sw - cw) / 2), sy = Math.round((sh - ch) / 2);
    const big = cw >= 3000;                              // 大きい画像は高解像度で保持
    const cv = document.createElement('canvas'); cv.width = big ? 4096 : 2048; cv.height = big ? 3072 : 1536;
    const ctx = cv.getContext('2d'); ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, cw, ch, 0, 0, cv.width, cv.height);
    return { canvas: cv, crop: { sw, sh, cw, ch } };
  }
  function loadFloorImage(file) {
    if (!file || !file.type.startsWith('image/')) { toast('画像ファイルを選んでください'); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const { canvas: cv, crop } = cropToFloor(img);
      imageCanvas = cv;
      setFloorSource('img');
      $('imgInfo').textContent = `${file.name}（${crop.sw}×${crop.sh} → 中央 ${crop.cw}×${crop.ch} を使用）`;
      $('loadMsg').textContent = '画像を床にしました';
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('画像を読み込めませんでした'); };
    img.src = url;
  }
  $('srcGen').addEventListener('click', () => setFloorSource('gen'));
  $('srcImg').addEventListener('click', () => setFloorSource('img'));
  $('imgFile').addEventListener('change', (e) => loadFloorImage(e.target.files[0]));
  {
    const panel = $('titleOverlay').querySelector('.panel');
    $('titleOverlay').addEventListener('dragover', (e) => { e.preventDefault(); panel.classList.add('dragover'); });
    $('titleOverlay').addEventListener('dragleave', () => panel.classList.remove('dragover'));
    $('titleOverlay').addEventListener('drop', (e) => {
      e.preventDefault(); panel.classList.remove('dragover');
      loadFloorImage(e.dataTransfer.files && e.dataTransfer.files[0]);
    });
  }

  // ---------- 隠れる人（寝転んだマネキン） ----------
  const man = Paint.createMannequin({ anisotropy: maxAniso });
  // 立ち姿（y up, 正面 +z）を x 軸で -90° 回して仰向けに。頭が -z 方向を向く
  man.group.rotation.x = -Math.PI / 2;
  man.group.position.set(0, 0.26, 0.71);   // 背中が床に触れる高さ、体の中心が原点に来るよう調整
  // 体の陰影・ツヤの強さ。0 = 床の絵と同じ平坦な見え方（塗った色がそのまま出る）、1 = 通常のライティング。
  // 仕組み: 発光(emissive)にテクスチャを (1-k) で、拡散色(ライト反射)に同じテクスチャを k で載せ、ツヤは roughness で絞る
  let shading = 0;
  const bodies = [man];        // 画面に出ている全員の体（自分 + オンラインで見つける人が受け取った隠れる人）
  function prepBody(b) {
    b.parts.forEach(p => {
      const m = p.mesh.material;
      m.emissive = new THREE.Color(1, 1, 1); m.emissiveMap = p.tex; m.needsUpdate = true;
    });
  }
  prepBody(man);
  function setShading(k) {
    shading = clamp(k, 0, 1);
    bodies.forEach(b => b.parts.forEach(p => {
      const m = p.mesh.material;
      m.color.setScalar(shading); m.emissive.setScalar(1 - shading);
      m.roughness = 1 - 0.45 * shading; m.metalness = 0;
    }));
    $('shade').value = Math.round(shading * 100); $('shadeOut').textContent = Math.round(shading * 100);
  }
  const player = new THREE.Object3D();
  player.scale.setScalar(PLAYER_SCALE);
  player.add(man.group); scene.add(player);
  let heading = 0;

  // ---------- カメラ ----------
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  const topCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  topCam.position.set(0, 30, 0); topCam.up.set(0, 0, -1); topCam.lookAt(0, 0, 0);
  let followZoom = 1;                       // 移動モードのズーム倍率
  let orbit = { theta: 0.3, phi: 0.75, dist: 3.2 * PLAYER_SCALE }; // ペイントモードの回転視点
  const camTarget = new THREE.Vector3();
  const desired = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  camera.position.set(0, 7, 5.5); lookAt.set(0, 0, 0);

  function updateCamera(dt, snap) {
    camTarget.copy(player.position); camTarget.y += 0.3 * PLAYER_SCALE;
    if (mode === 'paint') {
      const o = orbit;
      desired.set(camTarget.x + o.dist * Math.sin(o.phi) * Math.sin(o.theta),
                  camTarget.y + o.dist * Math.cos(o.phi),
                  camTarget.z + o.dist * Math.sin(o.phi) * Math.cos(o.theta));
    } else {
      const f = followZoom * PLAYER_SCALE * 1.3;
      desired.set(camTarget.x, camTarget.y + 7 * f, camTarget.z + 5.5 * f);
    }
    const k = snap ? 1 : 1 - Math.pow(0.002, dt);
    camera.position.lerp(desired, k);
    lookAt.lerp(camTarget, k);
    camera.lookAt(lookAt);
  }

  // ---------- ペイント ----------
  const painter = Paint.createPainter({ camera, domElement: canvas, parts: man.parts });
  scene.add(painter.cursor);
  painter.onChange = () => { $('undoBtn').disabled = !painter.canUndo(); };

  // ---------- 状態 ----------
  let phase = 'title';      // title | play | done（隠れる人） / wait | seek | result（見つける人）
  let mode = 'move';        // move | paint
  let tool = 'brush';       // brush | fill | drop（ペイント中の道具）
  let view = 'main';        // main | top（確認ビュー）
  let remaining = PREP_SECONDS, prepTotal = PREP_SECONDS;
  let clockOffset = 0;                     // サーバー時刻 − 手元の時刻（オンライン時）
  const nowMs = () => Date.now() + clockOffset;
  let net = null;                          // オンライン接続（online.js が設定）。null ならローカル
  const keys = new Set();

  function setMode(m) {
    if (m === 'paint' && isMoving()) { toast('止まってから切り替えてください'); return; }
    mode = m;
    painter.enabled = (m === 'paint' && phase === 'play' && view === 'main' && tool !== 'drop');
    $('modeMove').setAttribute('aria-pressed', String(m === 'move'));
    $('modePaint').setAttribute('aria-pressed', String(m === 'paint'));
    $('paintTools').hidden = (m !== 'paint');
    $('pip').hidden = (m !== 'paint' || phase !== 'play' || view !== 'main');
    stage.classList.toggle('paint', m === 'paint');
    $('hint').textContent = m === 'paint'
      ? '左ドラッグで塗る · Alt+クリックでスポイト · 右ドラッグで視点回転 · ホイールでズーム · Space で移動に戻る'
      : 'WASD 移動 · Q/E 回転 · Space でペイント · Enter で準備完了';
  }
  function isMoving() {
    return ['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].some(k => keys.has(k));
  }

  function startRound(opts) {
    opts = opts || {};
    phase = 'play'; view = 'main';
    prepTotal = opts.prepSeconds || PREP_SECONDS; remaining = prepTotal;
    player.position.set(opts.x || 0, 0, opts.z || 0); heading = opts.heading || 0; player.rotation.y = heading;
    player.visible = true; clearRemotes(); spectating = false; remoteAim = null;
    painter.reset(); setShading(0);
    $('titleOverlay').hidden = true; $('doneOverlay').hidden = true; $('topBar').hidden = true;
    $('readyBtn').disabled = false;
    clearBombs(); setHud('hider');
    setMode('move');
    updateCamera(0, true);
    prepEndsAt = opts.endsAt || nowMs() + prepTotal * 1000;
    if (!net) Link.send('prep', { endsAt: prepEndsAt, prepSeconds: prepTotal });
  }
  function finishRound(reason) {
    if (phase !== 'play') return;
    phase = 'done';
    painter.enabled = false; painter.cursor.visible = false;
    $('readyBtn').disabled = true; $('pip').hidden = true;
    if (net) {
      $('doneTitle').textContent = reason === 'timeout' ? '時間切れ！' : '準備完了！';
      $('doneMsg').textContent = '隠れた内容を送っています…';
      $('seekHereBtn').hidden = true; $('againBtn').hidden = true;
      $('doneOverlay').hidden = false;
      net.onHidden(reason);
      return;
    }
    hiddenPayload = makePayload();
    Link.send('hidden', hiddenPayload);
    $('doneTitle').textContent = reason === 'timeout' ? '時間切れ！' : '準備完了！';
    $('doneMsg').textContent = (reason === 'timeout' ? 'この場所と色で隠れます。' : '')
      + (seekerSeen ? '見つける人のタブに送りました。見つける人のターンが始まります。'
                    : '見つける人のタブがあれば自動で始まります。1 台で遊ぶ場合は交代してください。');
    $('seekHereBtn').hidden = false;
    $('doneOverlay').hidden = false;
  }
  function showTopView(on) {
    view = on ? 'top' : 'main';
    $('doneOverlay').hidden = on || phase !== 'done';
    setHud(on ? 'top' : 'hider');
    $('pip').hidden = on || mode !== 'paint' || phase !== 'play';
    stage.classList.toggle('topview', on);
    painter.enabled = false; painter.cursor.visible = false;
  }

  // ---------- 入力 ----------
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' && e.key !== 'Enter') return;
    const k = e.key.toLowerCase();
    if (phase !== 'play') return;
    if (k === ' ') { e.preventDefault(); setMode(mode === 'move' ? 'paint' : 'move'); return; }
    if (k === 'enter') { finishRound('ready'); return; }
    if (k === 'v' && e.ctrlKey) { e.preventDefault(); showTopView(view !== 'top'); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); if (mode === 'paint') painter.undo(); return; }
    if (mode === 'move' && view === 'main') keys.add(k);
  });
  document.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  // 視点操作（右ドラッグ / Shift+左ドラッグで回転、ホイールでズーム）
  let orbiting = false, lastX = 0, lastY = 0;
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    if (view !== 'main') return;
    if (e.button === 2 || (e.button === 0 && e.shiftKey)) {
      orbiting = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!orbiting) return;
    if (mode === 'paint') {
      orbit.theta -= (e.clientX - lastX) * 0.006;
      orbit.phi = clamp(orbit.phi - (e.clientY - lastY) * 0.006, 0.15, 1.45);
    }
    lastX = e.clientX; lastY = e.clientY;
  });
  const endOrbit = () => { orbiting = false; };
  canvas.addEventListener('pointerup', endOrbit);
  canvas.addEventListener('pointercancel', endOrbit);
  canvas.addEventListener('wheel', (e) => {
    if (view !== 'main') return;
    e.preventDefault();
    const f = Math.exp(e.deltaY * 0.0012);
    if (mode === 'paint') orbit.dist = clamp(orbit.dist * f, 1.6 * PLAYER_SCALE, 6 * PLAYER_SCALE);
    else followZoom = clamp(followZoom * f, 0.45, 1.8);
  }, { passive: false });
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ---------- UI ----------
  $('modeMove').addEventListener('click', () => setMode('move'));
  $('modePaint').addEventListener('click', () => setMode('paint'));
  $('readyBtn').addEventListener('click', () => finishRound('ready'));
  $('viewBtn').addEventListener('click', () => showTopView(true));
  $('shade').addEventListener('input', (e) => setShading(Number(e.target.value) / 100));
  $('backBtn').addEventListener('click', () => showTopView(false));
  $('againBtn').addEventListener('click', () => resetToTitle());
  $('startBtn').addEventListener('click', startRound);
  $('reseedBtn').addEventListener('click', () => {
    const v = parseInt($('seedInput').value, 10);
    buildFloor(Number.isFinite(v) && v !== seed ? v : Math.floor(Math.random() * 90000) + 1000);
  });
  $('seedInput').addEventListener('change', () => {
    const v = parseInt($('seedInput').value, 10); if (Number.isFinite(v) && v !== seed) buildFloor(v);
  });

  const palette = ['#e03a3a', '#f28c28', '#f2d64b', '#4cae4f', '#2d6ad8', '#7b4fd6', '#f08bb0', '#f5cba7', '#2a2a2e', '#ffffff'];
  const swBtns = palette.map((hex) => {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'sw'; b.style.background = hex; b.dataset.hex = hex; b.title = hex;
    b.addEventListener('click', () => setColor(hex));
    $('swatches').appendChild(b); return b;
  });
  function setColor(hex) {
    hex = hex.toLowerCase();
    painter.setColor(hex); $('colorPicker').value = hex;
    swBtns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.hex === hex)));
  }
  $('colorPicker').addEventListener('input', (e) => setColor(e.target.value));
  setColor(palette[0]);
  const syncSliders = () => {
    painter.setSize(Number($('size').value) / 100); $('sizeOut').textContent = $('size').value;
    painter.setHardness(Number($('hard').value) / 100); $('hardOut').textContent = $('hard').value;
  };
  $('size').addEventListener('input', syncSliders); $('hard').addEventListener('input', syncSliders); syncSliders();
  function setTool(t) {
    tool = t;
    if (t !== 'drop') painter.mode = t;
    painter.enabled = (mode === 'paint' && phase === 'play' && view === 'main' && t !== 'drop');
    $('toolBrush').setAttribute('aria-pressed', String(t === 'brush'));
    $('toolFill').setAttribute('aria-pressed', String(t === 'fill'));
    $('toolDrop').setAttribute('aria-pressed', String(t === 'drop'));
    stage.classList.toggle('drop', t === 'drop');
  }
  $('toolBrush').addEventListener('click', () => setTool('brush'));
  $('toolFill').addEventListener('click', () => setTool('fill'));
  $('toolDrop').addEventListener('click', () => setTool('drop'));

  // ---------- スポイト ----------
  const floorRay = new THREE.Raycaster(), floorNdc = new THREE.Vector2();
  function pickColorAt(cx, cy) {
    // 体の上なら塗ってある色、そうでなければ床の色
    const h = painter.hitAt(cx, cy);
    if (h) {
      const d = h.part.ctx.getImageData(clamp(Math.floor(h.u * h.part.W), 0, h.part.W - 1), clamp(Math.floor(h.v * h.part.H), 0, h.part.H - 1), 1, 1).data;
      return [d[0], d[1], d[2]];
    }
    const r = canvas.getBoundingClientRect();
    floorNdc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    floorRay.setFromCamera(floorNdc, camera);
    const hit = floorRay.intersectObject(floorMesh, false)[0];
    return hit ? sampleFloor(hit.point.x, hit.point.z) : null;
  }
  const toHex = (rgb) => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
  // ペイントモジュールより先に受け取る（capture）。スポイト時はペイント側へ渡さない
  canvas.addEventListener('pointerdown', (e) => {
    if (mode !== 'paint' || phase !== 'play' || view !== 'main' || e.button !== 0 || e.shiftKey) return;
    if (tool !== 'drop' && !e.altKey) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const rgb = pickColorAt(e.clientX, e.clientY);
    if (!rgb) return;
    setColor(toHex(rgb)); toast(`色を拾いました ${toHex(rgb)}`);
    if (tool === 'drop') setTool('brush');
  }, true);

  // ---------- 一括擬態: 体の各点の真下にある床の色で塗る ----------
  function camouflage() {
    scene.updateMatrixWorld(true);
    const fd = getFloorData(), fw = fd.width, fh = fd.height, fdata = fd.data;
    const t0 = performance.now();
    painter.transact((parts) => {
      for (const part of parts) {
        const geo = part.mesh.geometry, pos = geo.attributes.position, uv = geo.attributes.uv;
        // 回転体の頂点並び: i(周方向) × j(プロファイル)。最初の列 (i = 0) は uv.x = 0
        let n = 0; while (n < uv.count && uv.getX(n) === 0) n++;
        const prof = new Float32Array(n * 2);           // [r, y] をプロファイル順に
        for (let j = 0; j < n; j++) { prof[j * 2] = pos.getZ(j); prof[j * 2 + 1] = pos.getY(j); }
        const W = part.W, H = part.H, m = part.mesh.matrixWorld.elements;
        const sinU = new Float32Array(W), cosU = new Float32Array(W);
        for (let x = 0; x < W; x++) { const a = (x + 0.5) / W * Math.PI * 2; sinU[x] = Math.sin(a); cosU[x] = Math.cos(a); }
        const img = part.ctx.createImageData(W, H), out = img.data;
        for (let y = 0; y < H; y++) {
          const jf = (1 - (y + 0.5) / H) * (n - 1), j0 = Math.min(n - 2, Math.floor(jf)), t = jf - j0;
          const r = prof[j0 * 2] * (1 - t) + prof[j0 * 2 + 2] * t;
          const ly = prof[j0 * 2 + 1] * (1 - t) + prof[j0 * 2 + 3] * t;
          for (let x = 0; x < W; x++) {
            const lx = r * sinU[x], lz = r * cosU[x];
            const wx = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
            const wz = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
            // モザイク: 床を CAMO_BLOCK 四方のブロックに区切り、ブロック中心の色を使う
            const bx = (Math.floor(wx / CAMO_BLOCK) + 0.5) * CAMO_BLOCK, bz = (Math.floor(wz / CAMO_BLOCK) + 0.5) * CAMO_BLOCK;
            const px = Math.min(fw - 1, Math.max(0, (bx / WORLD_W + 0.5) * fw | 0));
            const py = Math.min(fh - 1, Math.max(0, (bz / WORLD_H + 0.5) * fh | 0));
            const fi = (py * fw + px) * 4, oi = (y * W + x) * 4;
            const cr = fdata[fi], cg = fdata[fi + 1], cb = fdata[fi + 2];
            const g = 0.299 * cr + 0.587 * cg + 0.114 * cb;   // 彩度を落とし、少し白に寄せる
            out[oi]     = (g + (cr - g) * CAMO_SAT) * (1 - CAMO_LIGHT) + 255 * CAMO_LIGHT;
            out[oi + 1] = (g + (cg - g) * CAMO_SAT) * (1 - CAMO_LIGHT) + 255 * CAMO_LIGHT;
            out[oi + 2] = (g + (cb - g) * CAMO_SAT) * (1 - CAMO_LIGHT) + 255 * CAMO_LIGHT;
            out[oi + 3] = 255;
          }
        }
        part.ctx.putImageData(img, 0, 0);
      }
    });
    toast(`真下の床に合わせて塗りました（${Math.round(performance.now() - t0)} ms）`);
  }
  $('camoBtn').addEventListener('click', camouflage);
  $('undoBtn').addEventListener('click', () => painter.undo());
  $('resetBtn').addEventListener('click', () => painter.reset());

  let toastTimer = 0;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
  }

  // ---------- ミニマップ ----------
  const mm = $('minimap'), mmCtx = mm.getContext('2d');
  const PX = mm.width / WORLD_W;             // unit → px
  function drawMinimap() {
    mmCtx.drawImage(mmCache, 0, 0);
    mmCtx.save();
    mmCtx.translate((player.position.x + WORLD_W / 2) * PX, (player.position.z + WORLD_H / 2) * PX);
    mmCtx.rotate(-heading);
    mmCtx.save(); mmCtx.scale(PLAYER_SCALE, PLAYER_SCALE);
    // 寝転んだ体のシルエット（頭が -z = 上）
    mmCtx.fillStyle = '#e03a3a'; mmCtx.strokeStyle = '#fff'; mmCtx.lineWidth = 2;
    roundRect(mmCtx, -0.45 * PX, -0.75 * PX, 0.9 * PX, 1.75 * PX, 0.4 * PX); mmCtx.fill(); mmCtx.stroke();
    mmCtx.beginPath(); mmCtx.arc(0, -0.85 * PX, 0.28 * PX, 0, Math.PI * 2); mmCtx.fill(); mmCtx.stroke();
    mmCtx.restore();
    // 目立たせるための輪（ゆっくり脈打つ）
    const pulse = 0.55 + 0.1 * Math.sin(performance.now() / 300);
    mmCtx.beginPath(); mmCtx.arc(0, 0, pulse * PX, 0, Math.PI * 2);
    mmCtx.strokeStyle = 'rgba(255,255,255,.9)'; mmCtx.lineWidth = 3; mmCtx.stroke();
    mmCtx.strokeStyle = '#e03a3a'; mmCtx.lineWidth = 1.5; mmCtx.stroke();
    mmCtx.restore();
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  // ---------- 小窓: 見つける人から見える真上の景色（ペイント中） ----------
  const pipCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  pipCam.up.set(0, 0, -1);
  const PIP_ZOOMS = [1, 2, 4]; let pipZoomIdx = 0;
  $('pip').addEventListener('click', () => {
    pipZoomIdx = (pipZoomIdx + 1) % PIP_ZOOMS.length;
    const z = PIP_ZOOMS[pipZoomIdx];
    $('pipLabel').textContent = z === 1 ? '見つける人の見え方 · 同じ縮尺（クリックで拡大）' : `見つける人の見え方 · ${z} 倍に拡大`;
  });
  function renderPip() {
    const r = $('pip').getBoundingClientRect(), sr = canvas.getBoundingClientRect();
    const pw = r.width, ph = r.height;
    if (pw < 10 || ph < 10) return;
    // 見つける人の画面（床全体が収まる真上ビュー）と同じ px/unit を基準にする
    const seekerPxPerUnit = sr.height / (topCam.top - topCam.bottom);
    const unitsH = ph / (seekerPxPerUnit * PIP_ZOOMS[pipZoomIdx]);
    const unitsW = unitsH * pw / ph;
    pipCam.left = -unitsW / 2; pipCam.right = unitsW / 2; pipCam.top = unitsH / 2; pipCam.bottom = -unitsH / 2;
    pipCam.updateProjectionMatrix();
    pipCam.position.set(player.position.x, 30, player.position.z);
    pipCam.lookAt(player.position.x, 0, player.position.z);
    const x = r.left - sr.left, y = sr.bottom - r.bottom;   // WebGL は左下原点
    renderer.setScissorTest(true);
    renderer.setViewport(x, y, pw, ph); renderer.setScissor(x, y, pw, ph);
    renderer.render(scene, pipCam);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, sr.width, sr.height);
  }

  // =====================================================================
  // 見つける人（ステップ 2）
  // =====================================================================
  let prepEndsAt = 0;          // 隠れる人の準備が終わる時刻（Date.now 基準。タブ間で共有）
  let seekerSeen = false;      // 見つける人のタブが開いているか（隠れる人のタブ側で使う）
  let hiddenPayload = null;    // 隠れた結果（床・体の塗り・位置）
  let seekEndsAt = 0, seekTotal = SEEK_SECONDS, seekRemaining = SEEK_SECONDS, seekLocal = false;
  let bombsTotal = BOMBS, bombsLeft = BOMBS, hidersCount = HIDERS, foundCount = 0;
  const bombs = [];            // 床に残る爆撃マーク
  let spectating = false;      // 隠れる人が見つける人と同じ画面を観ている
  let remoteAim = null;        // 観戦中に表示する見つける人の照準 { x, z, at }
  // カットイン演出（「〇〇をみつけた！」など）
  let cutinTimer = 0;
  function cutin(text, kind) {
    const el = $('cutin');
    $('cutinText').textContent = text;
    el.className = 'hud ' + (kind || 'win');
    el.hidden = false; void el.offsetWidth; el.classList.add('play');
    clearTimeout(cutinTimer); cutinTimer = setTimeout(() => { el.hidden = true; el.classList.remove('play'); }, 2300);
  }
  // カットイン中は結果パネルを少し待ってから出す（重ならないように）
  function showResultPanel() {
    const wait = $('cutin').hidden ? 0 : 1700;
    setTimeout(() => { if (phase === 'result' || spectating) $('resultOverlay').hidden = false; }, wait);
  }
  function setRemoteAim(x, z) {
    if (!remoteAim) aimRing.position.set(x, 0.02, z);
    remoteAim = { x, z, at: performance.now() };
  }
  const anims = [];            // 爆発エフェクト

  // HUD の出し分け: hider | top（確認ビュー） | seek | none
  function setHud(which) {
    const vis = (id, on) => { $(id).style.visibility = on ? 'visible' : 'hidden'; };
    vis('mmWrap', which === 'hider'); vis('bottom', which === 'hider'); vis('topRight', which === 'hider');
    $('seekHud').hidden = which !== 'seek'; $('spectateChip').hidden = true;
    $('topBar').hidden = which !== 'top';
    stage.classList.toggle('seek', which === 'seek');
  }

  // 隠れた状態をまとめる（床の画素・7 パーツの塗り・位置と向き）
  function makePayload() {
    return {
      floor: getFloorData(),
      parts: man.parts.map(p => p.ctx.getImageData(0, 0, p.W, p.H)),
      x: player.position.x, z: player.position.z, heading,
    };
  }
  function applyPayload(d) {
    const cv = document.createElement('canvas'); cv.width = d.floor.width; cv.height = d.floor.height;
    cv.getContext('2d').putImageData(d.floor, 0, 0);
    applyFloorCanvas(cv);
    man.parts.forEach((p, i) => { p.ctx.putImageData(d.parts[i], 0, 0); p.tex.needsUpdate = true; });
    player.position.set(d.x, 0, d.z); heading = d.heading; player.rotation.y = heading;
  }

  // ----- 待機画面 -----
  function enterWait() {
    phase = 'wait'; seekLocal = false;
    $('titleOverlay').hidden = true; $('waitOverlay').hidden = false; $('handoffBtn').hidden = true;
    $('waitTitle').firstChild.textContent = '隠れる人が準備中';
    setHud('none'); floorMesh.visible = false; player.visible = false;
    prepEndsAt = 0;
    $('waitMsg').textContent = Link.available
      ? '隠れる人の画面を別のタブで開き、「隠れる」を押すと始まります。'
      : 'このブラウザではタブ間の連携が使えません。1 台で交代して遊んでください。';
    Link.send('hello-seeker');
  }
  function updateWait() {
    if (phase !== 'wait' || seekLocal) return;
    if (!prepEndsAt) { $('waitTime').textContent = '-:--'; $('waitBar').style.transform = 'scaleX(1)'; return; }
    const left = Math.max(0, (prepEndsAt - nowMs()) / 1000);
    $('waitTime').textContent = fmt(left);
    $('waitBar').style.transform = `scaleX(${left / prepTotal})`;
    $('waitMsg').textContent = left > 0 ? 'もう少し待ってね。床はまだ見えません。' : 'まもなく始まります…';
  }
  // 1 台で交代するとき: 見つける人に画面を渡すための待機
  function enterHandoff() {
    phase = 'wait'; seekLocal = true;
    $('doneOverlay').hidden = true; $('waitOverlay').hidden = false; $('handoffBtn').hidden = false;
    $('waitTitle').firstChild.textContent = '見つける人に交代';
    $('waitTime').textContent = fmt(SEEK_SECONDS); $('waitBar').style.transform = 'scaleX(1)';
    $('waitMsg').textContent = `画面を見つける人に渡してください。爆弾 ${BOMBS} 発・制限時間 ${SEEK_SECONDS} 秒です。`;
    setHud('none'); player.visible = false; floorMesh.visible = false;
  }

  // ----- 捜索（爆撃） -----
  function startSeek(data) {
    if (data) applyPayload(data);
    phase = 'seek'; view = 'top';
    seekTotal = SEEK_SECONDS; seekEndsAt = nowMs() + seekTotal * 1000; seekRemaining = seekTotal;
    bombsTotal = BOMBS; bombsLeft = BOMBS; hidersCount = HIDERS; foundCount = 0;
    clearBombs(); setShading(0);
    painter.enabled = false; painter.cursor.visible = false; keys.clear();
    floorMesh.visible = true; player.visible = true;
    ['titleOverlay', 'waitOverlay', 'doneOverlay', 'resultOverlay'].forEach(id => { $(id).hidden = true; });
    $('pip').hidden = true;
    setHud('seek'); updateSeekHud();
    Link.send('seek-start', { endsAt: Date.now() + SEEK_SECONDS * 1000 });
  }
  function updateSeekHud() {
    $('bombDots').innerHTML = Array.from({ length: bombsTotal }, (_, i) => `<i class="${i < bombsTotal - bombsLeft ? 'used' : ''}"></i>`).join('');
    $('foundText').textContent = `${foundCount} / ${hidersCount}`;
    $('seekTime').textContent = fmt(seekRemaining);
    $('seekTimeChip').classList.toggle('warn', seekRemaining <= 10);
  }
  function tickSeek() {
    if (phase !== 'seek' && !(spectating && phase === 'done')) return;
    seekRemaining = Math.max(0, (seekEndsAt - nowMs()) / 1000);
    const elapsed = seekTotal - seekRemaining;
    // 制限時間が迫るにつれて人の影・ツヤを出す
    setShading((elapsed / seekTotal - SHADE_START) / (1 - SHADE_START));
    $('seekTime').textContent = fmt(seekRemaining);
    $('seekTimeChip').classList.toggle('warn', seekRemaining <= 10);
    if (seekRemaining <= 0 && !net && !spectating) endSeek('timeout');   // オンラインはサーバー、観戦中は見つける人の判定を待つ
  }

  // 爆撃マークと爆発エフェクト
  const markGeo = new THREE.CircleGeometry(BOMB_RADIUS, 48);
  const ringGeo = new THREE.RingGeometry(BOMB_RADIUS * 0.93, BOMB_RADIUS, 48);
  const crossGeo = new THREE.PlaneGeometry(BOMB_RADIUS * 0.9, BOMB_RADIUS * 0.12);
  function addBombMark(x, z, hit) {
    const g = new THREE.Group(); g.position.set(x, 0.004, z); g.rotation.x = -Math.PI / 2;
    const col = hit ? 0xf2d64b : 0xe03a3a;
    g.add(new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, depthWrite: false })));
    g.add(new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false })));
    if (!hit) for (const a of [Math.PI / 4, -Math.PI / 4]) {
      const c = new THREE.Mesh(crossGeo, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.9, depthWrite: false }));
      c.rotation.z = a; g.add(c);
    }
    g.renderOrder = 5; scene.add(g); bombs.push(g);
    explode(x, z, hit);
  }

  // 爆風の演出: 閃光 → 衝撃波の輪 2 重 → 飛び散る破片 → 煙、画面の揺れ。どこが爆撃されたか誰でも分かるように大きめに出す
  const fxDisc = new THREE.CircleGeometry(1, 40);
  const fxRing = new THREE.RingGeometry(0.86, 1, 64);
  function fxMesh(geo, color, opacity, x, z, order) {
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, depthTest: false }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.3, z); m.renderOrder = order; scene.add(m); return m;
  }
  const FX_SCALE = 0.35;       // 演出の基準の大きさ（unit）。爆風の判定半径より大きく見せて、遠目でも分かるようにする
  function explode(x, z, hit) {
    const R0 = FX_SCALE;
    // 火の玉（橙 → 赤 → 暗く、広がって消える）
    const fire = fxMesh(fxDisc, 0xff8a1f, 0.95, x, z, 21);
    anims.push({ mesh: fire, t: 0, dur: 0.8, update: (k) => { fire.scale.setScalar(R0 * (0.5 + 1.5 * Math.sqrt(k))); fire.material.opacity = 0.95 * (1 - k * k); fire.material.color.setHSL(0.1 - 0.1 * k, 1, 0.58 - 0.3 * k); } });
    // 芯（黄色）
    const core = fxMesh(fxDisc, 0xffe066, 1, x, z, 22);
    anims.push({ mesh: core, t: 0, dur: 0.45, update: (k) => { core.scale.setScalar(R0 * (0.35 + 0.7 * Math.sqrt(k))); core.material.opacity = 1 - k; } });
    // 閃光（ごく短い白）
    const flash = fxMesh(fxDisc, 0xffffff, 1, x, z, 23);
    anims.push({ mesh: flash, t: 0, dur: 0.16, update: (k) => { flash.scale.setScalar(R0 * (0.3 + 0.6 * k)); flash.material.opacity = 1 - k; } });
    // 衝撃波（2 重の輪が爆風半径の 3 倍まで広がる）
    [0, 0.12].forEach((delay) => {
      const ring = fxMesh(fxRing, hit ? 0xf2d64b : 0xffffff, 0.9, x, z, 24);
      ring.visible = false;
      anims.push({ mesh: ring, t: -delay, dur: 0.8, update: (k) => { ring.visible = k >= 0; ring.scale.setScalar(R0 * (0.5 + 4.2 * Math.max(0, k))); ring.material.opacity = 0.9 * (1 - Math.max(0, k)); } });
    });
    // 破片（外向きに飛んで落ちる）
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + Math.random() * 0.3, sp = R0 * (1.6 + Math.random() * 2.2);
      const bit = fxMesh(fxDisc, [0xffd166, 0xff8a1f, 0xe03a3a, 0x2b2d33][i % 4], 1, x, z, 25);
      const size = R0 * (0.1 + Math.random() * 0.08);
      anims.push({ mesh: bit, t: 0, dur: 0.55 + Math.random() * 0.25, update: (k) => {
        const e = 1 - (1 - k) * (1 - k);
        bit.position.set(x + Math.cos(a) * sp * e, 0.3, z + Math.sin(a) * sp * e);
        bit.scale.setScalar(size * (1 - 0.6 * k)); bit.material.opacity = 1 - k * k;
      } });
    }
    // 煙（ゆっくり広がって薄れる）
    const smoke = fxMesh(fxDisc, 0x3a3c44, 0.45, x, z, 20);
    anims.push({ mesh: smoke, t: -0.15, dur: 1.6, update: (k) => { smoke.visible = k >= 0; smoke.scale.setScalar(R0 * (0.8 + 1.6 * Math.max(0, k))); smoke.material.opacity = 0.45 * (1 - Math.max(0, k)); } });
    // 画面の揺れ
    stage.classList.remove('shake'); void stage.offsetWidth; stage.classList.add('shake');
  }
  function clearBombs() {
    bombs.forEach(b => scene.remove(b)); bombs.length = 0;
    anims.forEach(a => scene.remove(a.mesh)); anims.length = 0;
    foundRing.visible = false; aimRing.visible = false;
  }
  let fxFrozen = false;        // 自動テストで演出の途中を撮るための一時停止
  function stepAnims(dt) {
    if (fxFrozen) dt = 0;
    for (let i = anims.length - 1; i >= 0; i--) {
      const a = anims[i]; a.t += dt;
      const k = Math.min(1, a.t / a.dur);
      a.update(k);
      if (k >= 1) { scene.remove(a.mesh); a.mesh.material.dispose(); anims.splice(i, 1); }
    }
    // 見つける人の照準（観戦中は相手の照準を滑らかに追う）
    if (spectating && remoteAim) {
      const fresh = performance.now() - remoteAim.at < 3000;
      aimRing.visible = phase === 'seek' || phase === 'done' ? fresh : false;
      aimRing.position.x += (remoteAim.x - aimRing.position.x) * Math.min(1, dt * 10);
      aimRing.position.z += (remoteAim.z - aimRing.position.z) * Math.min(1, dt * 10);
    }
    if (foundRing.visible) { const p = 1 + 0.08 * Math.sin(performance.now() / 180); foundRing.scale.setScalar(p); }
  }
  // 発見時に人を囲む輪 / 狙いの輪
  const foundRing = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.48, 64), new THREE.MeshBasicMaterial({ color: 0xf2d64b, depthTest: false, transparent: true }));
  foundRing.rotation.x = -Math.PI / 2; foundRing.renderOrder = 30; foundRing.visible = false; scene.add(foundRing);
  const aimRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false }));
  aimRing.rotation.x = -Math.PI / 2; aimRing.renderOrder = 25; aimRing.visible = false; scene.add(aimRing);
  function showFound() { foundRing.position.set(player.position.x, 0.01, player.position.z); foundRing.visible = true; }

  // 命中判定: 真上から見た体（全頂点）が爆風の円に入っているか
  const tv = new THREE.Vector3();
  function hitTest(x, z) {
    scene.updateMatrixWorld(true);
    const r2 = BOMB_RADIUS * BOMB_RADIUS;
    for (const p of man.parts) {
      const pos = p.mesh.geometry.attributes.position, m = p.mesh.matrixWorld;
      for (let i = 0; i < pos.count; i += 2) {
        tv.fromBufferAttribute(pos, i).applyMatrix4(m);
        const dx = tv.x - x, dz = tv.z - z;
        if (dx * dx + dz * dz <= r2) return true;
      }
    }
    return false;
  }

  // クリックした床の位置（真上の固定カメラ）
  const seekRay = new THREE.Raycaster(), seekNdc = new THREE.Vector2();
  function floorPointAt(cx, cy) {
    const r = canvas.getBoundingClientRect();
    seekNdc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    seekRay.setFromCamera(seekNdc, topCam);
    const h = seekRay.intersectObject(floorMesh, false)[0];
    return h ? h.point : null;
  }
  function dropBomb(x, z) {
    if (phase !== 'seek' || bombsLeft <= 0) return;
    if (net) { net.onBomb(x, z); return; }    // 命中はサーバーが判定する
    bombsLeft--;
    const hit = hitTest(x, z);
    if (hit) foundCount++;
    addBombMark(x, z, hit);
    updateSeekHud();
    Link.send('bomb', { x, z, hit, left: bombsLeft });
    if (hit) { showFound(); cutin('隠れる人をみつけた！', 'win'); }
    else toast(bombsLeft > 0 ? `はずれ… 残り ${bombsLeft} 発` : 'はずれ… 爆弾がなくなりました');
    if (foundCount >= HIDERS) endSeek('found');
    else if (bombsLeft <= 0) endSeek('nobombs');
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (phase !== 'seek' || e.button !== 0 || spectating) return;
    const p = floorPointAt(e.clientX, e.clientY);
    if (p) dropBomb(p.x, p.z);
  });
  let lastAimSent = 0;
  canvas.addEventListener('pointermove', (e) => {
    if (spectating) return;
    if (phase !== 'seek') { aimRing.visible = false; return; }
    const p = floorPointAt(e.clientX, e.clientY);
    aimRing.visible = !!p && bombsLeft > 0;
    if (!p) return;
    aimRing.position.set(p.x, 0.02, p.z);
    // 照準を観戦中の人に送る（ローカルは 50 ms ごと、オンラインは online.js が間引く）
    const t = performance.now();
    if (net) net.onAim && net.onAim(p.x, p.z);
    else if (t - lastAimSent > 50) { lastAimSent = t; Link.send('aim', { x: p.x, z: p.z }); }
  });
  canvas.addEventListener('pointerleave', () => { if (!spectating) aimRing.visible = false; });

  function endSeek(reason) {
    if (phase !== 'seek') return;
    phase = 'result'; aimRing.visible = false;
    const found = foundCount >= hidersCount;
    showFound(); setShading(1);                 // 答え合わせ: 隠れ場所を光らせ、影・ツヤを付ける
    const used = bombsTotal - bombsLeft, t = Math.round(seekTotal - seekRemaining);
    $('resultTitle').textContent = found ? '見つけた！' : '逃げ切られた…';
    $('resultTitle').className = found ? 'win' : 'lose';
    $('resultMsg').textContent = found
      ? `${used} 発目で発見（${t} 秒）。黄色い輪が隠れていた場所です。`
      : (reason === 'timeout' ? '時間切れ。' : '爆弾を使い切りました。') + '黄色い輪が隠れていた場所です。';
    showResultPanel();
    Link.send('result', { found, used, seconds: t, reason });
  }

  // ----- タブ間の連携 -----
  Link.on('hello-seeker', () => { if (net) return;             // 見つける人のタブが開いた
    seekerSeen = true;
    if (phase === 'play') Link.send('prep', { endsAt: prepEndsAt, prepSeconds: PREP_SECONDS });
    else if (phase === 'done' && hiddenPayload) Link.send('hidden', hiddenPayload);
  });
  Link.on('prep', (m) => { if (net) return; if (phase === 'wait' && !seekLocal) { prepEndsAt = m.endsAt; updateWait(); } });
  Link.on('hidden', (m) => { if (net) return; if (phase === 'wait' && !seekLocal) startSeek(m); });
  Link.on('seek-start', () => { if (net) return;               // 隠れる人のタブ: 見つける人のターンが始まった
    seekerSeen = true;
    if (phase !== 'done') return;
    enterSpectate(Date.now() + SEEK_SECONDS * 1000, SEEK_SECONDS, BOMBS, BOMBS, HIDERS);
  });
  Link.on('aim', (m) => { if (net) return; if (spectating) setRemoteAim(m.x, m.z); });
  Link.on('bomb', (m) => { if (net) return;
    if (phase !== 'done') return;
    addBombMark(m.x, m.z, m.hit);
    bombsLeft = m.left; if (m.hit) foundCount++;
    if (spectating) updateSeekHud();
    if (m.hit) { showFound(); cutin('みつかってしまった…', 'lose'); }
    else toast(`はずれ！ 残り ${m.left} 発`);
  });
  Link.on('result', (m) => { if (net) return;
    if (phase !== 'done') return;
    showFound(); setShading(1); aimRing.visible = false; remoteAim = null;
    $('resultTitle').textContent = m.found ? '見つかった…' : '逃げ切った！';
    $('resultTitle').className = m.found ? 'lose' : 'win';
    $('resultMsg').textContent = m.found ? `${m.used} 発目で見つかりました（${m.seconds} 秒）。` : '最後まで見つかりませんでした。';
    $('resultBackBtn').textContent = 'タイトルに戻る'; $('resultBackBtn').disabled = false;
    if (!m.found) cutin('逃げ切った！', 'win');
    showResultPanel();
  });

  // 隠れる人の画面を、見つける人と同じ真上の固定視点に切り替える（操作はできない）
  function enterSpectate(endsAt, seconds, total, left, hiders) {
    spectating = true; remoteAim = null; view = 'top';
    seekEndsAt = endsAt; seekTotal = seconds; seekRemaining = seconds;
    bombsTotal = total; bombsLeft = left; hidersCount = hiders; foundCount = 0;
    painter.enabled = false; painter.cursor.visible = false; keys.clear();
    ['titleOverlay', 'waitOverlay', 'doneOverlay', 'resultOverlay', 'topBar'].forEach(id => { $(id).hidden = true; });
    $('pip').hidden = true; setHud('seek'); $('spectateChip').hidden = false;
    updateSeekHud();
  }

  // ----- タイトルに戻る -----
  function resetToTitle(opts) {
    phase = 'title'; view = 'main'; seekLocal = false; hiddenPayload = null;
    ['doneOverlay', 'waitOverlay', 'resultOverlay'].forEach(id => { $(id).hidden = true; });
    $('titleOverlay').hidden = !!(opts && opts.keepHidden);
    $('againBtn').hidden = false; clearRemotes(); spectating = false; remoteAim = null; $('cutin').hidden = true;
    clearBombs(); setShading(0); player.visible = true; painter.reset();
    stage.classList.remove('topview');
    setHud('hider'); setMode('move');
    // 見つける人として受け取った床は捨て、タイトルで選んでいる床に戻す
    if (floorSource === 'img' && imageCanvas) applyFloorCanvas(imageCanvas);
    else if (floorSource === 'gen') buildFloor(seed);
    else floorMesh.visible = false;
  }

  $('seekWaitBtn').addEventListener('click', enterWait);
  $('waitCancelBtn').addEventListener('click', () => { if (net) net.onLeave(); else resetToTitle(); });
  $('seekHereBtn').addEventListener('click', enterHandoff);
  $('handoffBtn').addEventListener('click', () => startSeek(null));
  $('resultBackBtn').addEventListener('click', () => { if (net) net.onResultBack(); else resetToTitle(); });
  const fmt = (sec) => { const s = Math.ceil(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  // =====================================================================
  // オンライン対戦との橋渡し（online.js から window.__game 経由で使う）
  // =====================================================================
  const remotes = new Map();   // hiderId → { holder, body, ring }
  // 体の 7 パーツを 1 枚の画像にまとめる配置（docs/online-protocol.md と同じ）
  function atlasLayout(parts) {
    let x = 0, y = 0, rowH = 0;
    const pos = parts.map(p => {
      if (x + p.W > 1024) { x = 0; y += rowH; rowH = 0; }
      const r = { x, y }; x += p.W; rowH = Math.max(rowH, p.H); return r;
    });
    return { pos, height: y + rowH };
  }
  function makeAtlas() {
    const { pos, height } = atlasLayout(man.parts);
    const cv = document.createElement('canvas'); cv.width = 1024; cv.height = height;
    const g = cv.getContext('2d');
    man.parts.forEach((p, i) => g.drawImage(p.cv, pos[i].x, pos[i].y));
    return cv;
  }
  function applyAtlas(parts, img) {
    const { pos } = atlasLayout(parts);
    parts.forEach((p, i) => {
      p.ctx.clearRect(0, 0, p.W, p.H);
      p.ctx.drawImage(img, pos[i].x, pos[i].y, p.W, p.H, 0, 0, p.W, p.H);
      p.tex.needsUpdate = true;
    });
  }
  // 命中判定用: 真上から見た体の点群（床座標 [x, z]、最大 500 点）
  function outlinePoints() {
    scene.updateMatrixWorld(true);
    const pts = [];
    for (const p of man.parts) {
      const pos = p.mesh.geometry.attributes.position, m = p.mesh.matrixWorld;
      for (let i = 0; i < pos.count; i += 3) { tv.fromBufferAttribute(pos, i).applyMatrix4(m); pts.push([tv.x, tv.z]); }
    }
    const step = Math.ceil(pts.length / 500);
    return pts.filter((_, i) => i % step === 0).map(([x, z]) => [Math.round(x * 1000) / 1000, Math.round(z * 1000) / 1000]);
  }
  function addRemote(id, img, x, z, h) {
    const body = Paint.createMannequin({ anisotropy: maxAniso });
    body.group.rotation.x = -Math.PI / 2; body.group.position.set(0, 0.26, 0.71);
    applyAtlas(body.parts, img); prepBody(body); bodies.push(body);
    const holder = new THREE.Object3D(); holder.scale.setScalar(PLAYER_SCALE);
    holder.add(body.group); holder.position.set(x, 0, z); holder.rotation.y = h; scene.add(holder);
    const ring = new THREE.Mesh(foundRing.geometry, foundRing.material);
    ring.rotation.x = -Math.PI / 2; ring.renderOrder = 30; ring.position.set(x, 0.01, z); ring.visible = false; scene.add(ring);
    remotes.set(id, { holder, body, ring });
    setShading(shading);
  }
  function clearRemotes() {
    remotes.forEach(r => {
      scene.remove(r.holder); scene.remove(r.ring);
      const i = bodies.indexOf(r.body); if (i >= 0) bodies.splice(i, 1);
      r.body.parts.forEach(p => { p.tex.dispose(); p.mesh.geometry.dispose(); p.mesh.material.dispose(); });
    });
    remotes.clear();
  }
  let bombsDrawn = 0;
  window.__game = {
    attachNet(n) { net = n; },
    detachNet() { net = null; },
    setClockOffset(ms) { clockOffset = ms; },
    phase: () => phase,
    toast, setHud, applyFloorCanvas, resetToTitle,
    floorCanvas: () => floorCanvas,
    titleFloorCanvas: () => (floorSource === 'img' ? imageCanvas : (floorSource === 'gen' ? floorCanvas : null)),
    startHiding(o) { startRound(o); },
    pose: () => ({ x: player.position.x, z: player.position.z, heading }),
    makeAtlas, outlinePoints,
    cropToFloor: (img) => cropToFloor(img).canvas,
    hiddenSent(msg) { $('doneMsg').textContent = msg; },
    enterWaitOnline(endsAt, prepSeconds) {
      phase = 'wait'; seekLocal = false; prepEndsAt = endsAt; prepTotal = prepSeconds;
      ['titleOverlay', 'doneOverlay', 'resultOverlay'].forEach(id => { $(id).hidden = true; });
      $('waitOverlay').hidden = false; $('handoffBtn').hidden = true;
      $('waitTitle').firstChild.textContent = '隠れる人が準備中';
      setHud('none'); floorMesh.visible = false; player.visible = false; clearRemotes();
      updateWait();
    },
    // 見つける人: 全員の隠れた結果を受け取って捜索開始
    startSeekOnline(o) {
      phase = 'seek'; view = 'top'; spectating = !!o.spectator; remoteAim = null;
      seekEndsAt = o.endsAt; seekTotal = o.seekSeconds; seekRemaining = seekTotal;
      bombsTotal = o.bombsTotal; bombsLeft = o.bombsLeft; hidersCount = o.hiders.length; foundCount = 0; bombsDrawn = 0;
      clearBombs(); clearRemotes(); setShading(0);
      o.hiders.forEach(h => addRemote(h.id, h.img, h.x, h.z, h.heading));
      painter.enabled = false; painter.cursor.visible = false; keys.clear();
      floorMesh.visible = true; player.visible = false;
      ['titleOverlay', 'waitOverlay', 'doneOverlay', 'resultOverlay'].forEach(id => { $(id).hidden = true; });
      $('pip').hidden = true; setHud('seek'); $('spectateChip').hidden = !spectating; updateSeekHud();
    },
    setRemoteAim, cutin,
    // サーバーの状態（爆撃・発見）を画面に反映。隠れる人の画面でも使う
    syncBombs(room, meId) {
      const list = room.bombs || [];
      for (; bombsDrawn < list.length; bombsDrawn++) {
        const b = list[bombsDrawn]; addBombMark(b.x, b.z, b.hit);
        if (phase !== 'seek') continue;
        if (!b.hit) { toast(room.bombsLeft > 0 ? `はずれ… 残り ${room.bombsLeft} 発` : 'はずれ… 爆弾がなくなりました'); continue; }
        const names = (room.hiders || []).filter(h => (b.hitIds || []).includes(h.id)).map(h => h.name).join('・');
        if (!spectating) cutin(`${names}をみつけた！`, 'win');
        else if ((b.hitIds || []).includes(meId)) cutin('みつかってしまった…', 'lose');
        else cutin(`${names}がみつかった！`, 'lose');
      }
      bombsLeft = room.bombsLeft; bombsTotal = room.bombsTotal || bombsTotal;
      foundCount = (room.hiders || []).filter(h => h.found).length;
      (room.hiders || []).forEach(h => { const r = remotes.get(h.id); if (r) r.ring.visible = h.found; });
      if (phase === 'seek') updateSeekHud();
    },
    resetBombs() { clearBombs(); bombsDrawn = 0; },
    // 見つける人の結果表示
    showSeekResult(title, msg, win, backLabel, backEnabled) {
      phase = 'result'; aimRing.visible = false; remoteAim = null; setShading(1);
      remotes.forEach(r => { r.ring.visible = true; });
      $('resultTitle').textContent = title; $('resultTitle').className = win ? 'win' : 'lose';
      $('resultMsg').textContent = msg;
      $('resultBackBtn').textContent = backLabel; $('resultBackBtn').disabled = !backEnabled;
      showResultPanel();
    },
    // 隠れる人の画面の文言
    showHiderStatus(title, msg) {
      $('doneTitle').textContent = title; $('doneMsg').textContent = msg;
      $('seekHereBtn').hidden = true; $('againBtn').hidden = true;
      $('doneOverlay').hidden = view === 'top';   // 確認ビュー中は覆わない
    },
    showFoundSelf: () => showFound(),
  };

  // ---------- タイマー ----------
  function updateTimer() {
    if (phase === 'play') remaining = Math.max(0, (prepEndsAt - nowMs()) / 1000);
    const s = Math.ceil(remaining);
    $('timerText').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('timer').classList.toggle('warn', phase === 'play' && s <= 10);
    if (phase === 'play' && remaining <= 0) finishRound('timeout');
  }

  // ---------- リサイズ / ループ ----------
  function resize() {
    const w = stage.clientWidth, h = stage.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    // 真上ビュー: 床全体（余白込み）が必ず画面に収まるように
    const aspect = w / h, fh = Math.max(WORLD_H + 1, (WORLD_W + 1) / aspect);
    topCam.left = -fh * aspect / 2; topCam.right = fh * aspect / 2; topCam.top = fh / 2; topCam.bottom = -fh / 2;
    topCam.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage); resize();

  let last = performance.now();
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (phase === 'play' && mode === 'move' && view === 'main') {
      let vx = 0, vz = 0;
      if (keys.has('w') || keys.has('arrowup')) vz -= 1;
      if (keys.has('s') || keys.has('arrowdown')) vz += 1;
      if (keys.has('a') || keys.has('arrowleft')) vx -= 1;
      if (keys.has('d') || keys.has('arrowright')) vx += 1;
      if (vx || vz) { const l = Math.hypot(vx, vz); vx /= l; vz /= l; }
      player.position.x = clamp(player.position.x + vx * MOVE_SPEED * dt, -WORLD_W / 2 + MARGIN, WORLD_W / 2 - MARGIN);
      player.position.z = clamp(player.position.z + vz * MOVE_SPEED * dt, -WORLD_H / 2 + MARGIN, WORLD_H / 2 - MARGIN);
      if (keys.has('q')) heading += ROT_SPEED * dt;
      if (keys.has('e')) heading -= ROT_SPEED * dt;
      player.rotation.y = heading;
    }
    updateTimer(); updateWait(); tickSeek(); stepAnims(dt);
    updateCamera(dt, false);
    drawMinimap();
    // ブラシカーソルは world 単位なので人の縮尺に合わせる
    if (painter.cursor.visible) painter.cursor.scale.setScalar((painter.mode === 'fill' ? 0.02 : painter.size) * PLAYER_SCALE);
    renderer.render(scene, view === 'top' ? topCam : camera);
    if (!$('pip').hidden) renderPip();
    requestAnimationFrame(loop);
  }

  // 開発用: 画面中央付近で合成ポインタイベントによる一筆を描く（#start,paint,demo）
  function demoStroke() {
    const r = canvas.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const ev = (type, x, y, extra) => canvas.dispatchEvent(new PointerEvent(type, Object.assign({
      bubbles: true, cancelable: true, pointerId: 7, pointerType: 'mouse', isPrimary: true,
      clientX: x, clientY: y, button: 0, buttons: 1 }, extra || {})));
    ev('pointerdown', cx - 120, cy - 60);
    for (let i = 1; i <= 40; i++) ev('pointermove', cx - 120 + i * 6, cy - 60 + Math.sin(i / 4) * 40);
    ev('pointerup', cx + 120, cy - 60, { buttons: 0 });
    setColor('#2d6ad8'); setTool('fill');
    ev('pointerdown', cx + 40, cy + 170); ev('pointerup', cx + 40, cy + 170, { buttons: 0 });
    setTool('brush');
  }

  // 開発・自動テスト用の窓口（ゲーム内容には影響しない）
  window.kakurenbo = {
    state: () => ({ phase, view, bombsLeft, foundCount, shading, x: player.position.x, z: player.position.z, heading, prepEndsAt,
      spectating, aim: { visible: aimRing.visible, x: aimRing.position.x, z: aimRing.position.z }, cutin: $('cutin').hidden ? '' : $('cutinText').textContent }),
    screenOf(x, z) {   // 床の座標 → 画面座標（見つける人の真上ビュー）
      const v = new THREE.Vector3(x, 0, z).project(topCam), r = canvas.getBoundingClientRect();
      return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
    },
    finish: () => finishRound('ready'),
    freezeFx: (on) => { fxFrozen = !!on; },
    stepFx: (sec) => { const f = fxFrozen; fxFrozen = false; stepAnims(sec); fxFrozen = f; },
  };

  // ---------- 起動 ----------
  requestAnimationFrame(() => {   // タイトルを先に描いてから床を生成
    setMode('move'); setShading(0); updateTimer(); updateCamera(0, true);
    setFloorSource('img');   // 既定は画像取り込み。自動生成は「自動生成」を選んだときだけ行う
    requestAnimationFrame(loop);
    // 開発用: index.html#start / #start,paint / #start,top で画面を直接開く
    const flags = location.hash.slice(1).split(',');
    if (flags.includes('start')) {
      if (!floorCanvas) setFloorSource('gen');   // 開発用フラグで直接始めるときは床を生成
      startRound();
      player.position.set(2.5, 0, -1); heading = 0.6; player.rotation.y = heading; updateCamera(0, true);
      if (flags.includes('paint')) setMode('paint');
      if (flags.includes('demo')) setTimeout(demoStroke, 600);
      if (flags.includes('top')) { finishRound('ready'); showTopView(true); }
      if (flags.includes('shade')) setShading(1);
      if (flags.includes('camo')) setTimeout(camouflage, 300);
      if (flags.includes('pip4')) pipZoomIdx = 2;
    }
    if (flags.includes('seek')) enterWait();   // 開発用: 見つける人として待つ
    if (flags.includes('hotseat')) { finishRound('ready'); enterHandoff(); startSeek(null); }   // 開発用: 1 台で交代して捜索開始
    if (flags.includes('imgtest')) {   // 開発用: 横長のテスト画像を取り込む（切り抜きの確認）
      const c = document.createElement('canvas'); c.width = 1200; c.height = 500; const g = c.getContext('2d');
      const gr = g.createLinearGradient(0, 0, 1200, 0); gr.addColorStop(0, '#2d6ad8'); gr.addColorStop(1, '#f2d64b');
      g.fillStyle = gr; g.fillRect(0, 0, 1200, 500);
      g.fillStyle = '#e03a3a'; g.beginPath(); g.arc(600, 250, 200, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff'; g.font = 'bold 80px sans-serif'; g.textAlign = 'center'; g.fillText('TEST 1200x500', 600, 280);
      const img = new Image(); img.onload = () => { imageCanvas = cropToFloor(img).canvas; setFloorSource('img'); };
      img.src = c.toDataURL();
    }
  });
})();
