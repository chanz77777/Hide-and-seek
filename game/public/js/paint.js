/* paint.js — reusable texture-painting module ported from mannequin-paint.html.
 *
 * Classic browser script (no import/export). Load after Three.js r158 UMD so that
 * `window.THREE` exists. Exposes `window.Paint` with:
 *   Paint.createMannequin()                       -> { group, parts, meshes }
 *   Paint.createPainter({ camera, domElement, parts }) -> painter
 *
 * The painter never caches world positions: every hit test goes through
 * Raycaster.intersectObjects / mesh.worldToLocal, which read mesh.matrixWorld
 * (kept current by the renderer each frame), so the host may freely rotate or
 * move the mannequin group.
 */
(function () {
  'use strict';

  const THREE = window.THREE;
  if (!THREE) {
    console.error('paint.js: window.THREE is required (load three.min.js first).');
    return;
  }

  const UNDO_MAX = 20;

  // ---------- geometry: lathe profiles sampled evenly by arc length ----------
  // v then maps linearly to surface distance along the profile.
  // Profile points run from the bottom to the top; x = distance from the axis, y = height.
  function capsuleProfile(r, len, n) {
    const L = Math.PI * r + len, pts = [];
    for (let i = 0; i <= n; i++) {
      const s = L * i / n;
      let x, y;
      if (s <= Math.PI * r / 2) { const a = s / r; x = r * Math.sin(a); y = -len / 2 - r * Math.cos(a); }
      else if (s <= Math.PI * r / 2 + len) { x = r; y = -len / 2 + (s - Math.PI * r / 2); }
      else { const a = (s - Math.PI * r / 2 - len) / r; x = r * Math.cos(a); y = len / 2 + r * Math.sin(a); }
      pts.push(new THREE.Vector2(Math.max(x, 0), y));
    }
    return { pts, len: L };
  }
  function coneProfile(r0, r1, h, n) {
    const pts = [];
    for (let i = 0; i <= n; i++) { const t = i / n; pts.push(new THREE.Vector2(r0 + (r1 - r0) * t, -h / 2 + h * t)); }
    return { pts, len: Math.hypot(r1 - r0, h) };
  }

  // ---------- mannequin ----------
  // Standing pose, y up, feet at about y = -0.33, head top at about y = 1.75, front facing +z.
  // opts.anisotropy (optional): pass renderer.capabilities.getMaxAnisotropy() for sharper textures.
  function createMannequin(opts) {
    const anisotropy = (opts && opts.anisotropy) || 1;
    const group = new THREE.Group();
    group.name = 'mannequin';
    const parts = [], meshes = [];

    function addPart(name, profile, texW, texH, pos, rotZ, scale) {
      const geo = new THREE.LatheGeometry(profile.pts, 72);
      const cv = document.createElement('canvas'); cv.width = texW; cv.height = texH;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, texW, texH);
      const tex = new THREE.CanvasTexture(cv);
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = anisotropy;
      tex.wrapS = THREE.RepeatWrapping;
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55, metalness: 0 });
      const mesh = new THREE.Mesh(geo, mat); mesh.name = name;
      mesh.position.set(pos[0], pos[1], pos[2]);
      mesh.rotation.y = Math.PI;              // lathe seam (u = 0/1) faces backwards
      mesh.rotation.z = rotZ || 0;
      if (scale) mesh.scale.set(scale[0], scale[1], scale[2]);
      mesh.updateMatrixWorld(true);
      // sxz: average horizontal scale (circumference factor); profLen: profile length in world units
      const sxz = scale ? (scale[0] + scale[2]) / 2 : 1, sy = scale ? scale[1] : 1;
      parts.push({ name, mesh, cv, ctx, tex, W: texW, H: texH, profLen: profile.len * sy, sxz });
      meshes.push(mesh); group.add(mesh);
    }
    addPart('head',  capsuleProfile(0.25, 0, 96),      1024, 512,  [0, 1.50, 0]);
    addPart('neck',  coneProfile(0.12, 0.09, 0.22, 8),  512, 128,  [0, 1.22, 0]);
    addPart('torso', capsuleProfile(0.27, 0.50, 160),  1024, 1024, [0, 0.85, 0], 0, [1.15, 1, 0.80]);
    addPart('armL',  capsuleProfile(0.095, 0.62, 128),  512, 1024, [-0.43, 0.80, 0], -0.12);
    addPart('armR',  capsuleProfile(0.095, 0.62, 128),  512, 1024, [ 0.43, 0.80, 0],  0.12);
    addPart('legL',  capsuleProfile(0.115, 0.60, 128),  512, 1024, [-0.16, 0.10, 0]);
    addPart('legR',  capsuleProfile(0.115, 0.60, 128),  512, 1024, [ 0.16, 0.10, 0]);

    return { group, parts, meshes };
  }

  // Normalise a CSS hex color to lowercase '#rrggbb' (dab() appends '00' for the transparent stop).
  function normHex(hex) {
    let s = String(hex).trim().toLowerCase();
    if (/^#[0-9a-f]{3}$/.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
    if (/^#[0-9a-f]{6}$/.test(s)) return s;
    try { return '#' + new THREE.Color(s).getHexString(); } catch (_) { return '#000000'; }
  }

  // ---------- painter ----------
  function createPainter(opts) {
    const camera = opts.camera, domElement = opts.domElement, parts = opts.parts;
    if (!camera || !domElement || !parts) throw new Error('Paint.createPainter: camera, domElement and parts are required');
    const meshes = parts.map(p => p.mesh);

    // translucent brush sphere; the host adds it to the scene
    const cursor = new THREE.Mesh(
      new THREE.SphereGeometry(1, 24, 16),
      new THREE.MeshBasicMaterial({ color: 0x2d6ad8, transparent: true, opacity: 0.3, depthTest: false, depthWrite: false }));
    cursor.visible = false; cursor.renderOrder = 10; cursor.name = 'paintCursor';

    // state
    let enabled = false;
    let mode = 'brush';
    const brush = { r: 0.04, hardness: 0.9, hex: '#e03a3a' };
    cursor.material.color.set(brush.hex);

    // ---------- undo: one Map(part -> ImageData) per stroke ----------
    const undoStack = [];
    let strokeSaved = null;   // Map for the stroke in progress

    function notify() { if (typeof painter.onChange === 'function') painter.onChange(painter); }
    function beginStroke() { strokeSaved = new Map(); }
    function remember(part) {
      if (!strokeSaved || strokeSaved.has(part)) return;
      strokeSaved.set(part, part.ctx.getImageData(0, 0, part.W, part.H));
    }
    function endStroke() {
      let changed = false;
      if (strokeSaved && strokeSaved.size) {
        undoStack.push(strokeSaved);
        if (undoStack.length > UNDO_MAX) undoStack.shift();
        changed = true;
      }
      strokeSaved = null;
      if (changed) notify();
    }

    // ---------- hit testing / painting onto the texture ----------
    const raycaster = new THREE.Raycaster(); const ndc = new THREE.Vector2(); const local = new THREE.Vector3();
    function hitAt(cx, cy) {
      const r = domElement.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      ndc.x = ((cx - r.left) / r.width) * 2 - 1;
      ndc.y = -((cy - r.top) / r.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(meshes, false);   // mannequin meshes only
      if (!hits.length || !hits[0].uv) return null;
      const h = hits[0];
      const part = parts.find(p => p.mesh === h.object);
      if (!part) return null;
      // brush size in texels: u runs around the circumference at this height, v runs along the profile
      local.copy(h.point); h.object.worldToLocal(local);
      const circ = 2 * Math.PI * Math.hypot(local.x, local.z) * part.sxz;
      const rx = Math.min(part.W / 2, brush.r / Math.max(circ, 1e-4) * part.W);
      const ry = brush.r / part.profLen * part.H;
      return { part, point: h.point, u: h.uv.x, v: 1 - h.uv.y, rx, ry };
    }
    function dab(part, u, v, rx, ry) {
      const ctx = part.ctx, W = part.W, H = part.H;
      const x = u * W, y = v * H;
      const hard = Math.min(brush.hardness, 0.98);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, brush.hex); g.addColorStop(hard, brush.hex); g.addColorStop(1, brush.hex + '00');
      for (const ox of [-W, 0, W]) {          // repeat across the u seam
        if (x + ox + rx < 0 || x + ox - rx > W) continue;
        ctx.save(); ctx.translate(x + ox, y); ctx.scale(rx, ry);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      }
    }
    let lastHit = null;
    function strokeTo(h) {
      remember(h.part);
      if (lastHit && lastHit.part === h.part) {
        // interpolate dabs from the previous hit, taking the short way round the seam
        let du = h.u - lastHit.u; if (du > 0.5) du -= 1; if (du < -0.5) du += 1;
        const dv = h.v - lastHit.v;
        const px = Math.hypot(du * h.part.W, dv * h.part.H);
        const step = Math.max(1, Math.min(h.rx, h.ry) * 0.3);
        const n = Math.min(200, Math.ceil(px / step));
        for (let i = 1; i < n; i++) {
          const t = i / n;
          dab(h.part, (lastHit.u + du * t + 1) % 1, lastHit.v + dv * t,
              lastHit.rx + (h.rx - lastHit.rx) * t, lastHit.ry + (h.ry - lastHit.ry) * t);
        }
      }
      dab(h.part, h.u, h.v, h.rx, h.ry);
      h.part.tex.needsUpdate = true;
      lastHit = h;
    }
    function fillPart(part) {
      remember(part);
      part.ctx.fillStyle = brush.hex; part.ctx.fillRect(0, 0, part.W, part.H); part.tex.needsUpdate = true;
    }

    // ---------- pointer handling ----------
    // Paint only with the primary button and no Shift; everything else is left to the host
    // (right-drag / Shift-drag orbit, wheel zoom, contextmenu, multi-touch gestures).
    const active = new Set();   // pointer ids currently down on the canvas
    let painting = false, activeId = null;

    function stopStroke() {
      if (!painting) return;
      painting = false;
      endStroke();
      lastHit = null;
      if (activeId !== null) { try { domElement.releasePointerCapture(activeId); } catch (_) {} }
      activeId = null;
    }

    function onPointerDown(e) {
      active.add(e.pointerId);
      if (!enabled) return;
      if (active.size >= 2) { stopStroke(); return; }   // second finger: hand over to host gestures
      if (e.button !== 0 || e.shiftKey) return;
      const h = hitAt(e.clientX, e.clientY);
      if (mode === 'fill') {
        if (h) { beginStroke(); fillPart(h.part); endStroke(); }
        return;
      }
      painting = true; activeId = e.pointerId; lastHit = null; beginStroke();
      try { domElement.setPointerCapture(e.pointerId); } catch (_) {}
      if (h) strokeTo(h);
    }
    function onPointerMove(e) {
      if (!enabled) { cursor.visible = false; return; }
      if (active.size >= 2) { cursor.visible = false; return; }
      if (painting && e.pointerId !== activeId) return;
      const h = hitAt(e.clientX, e.clientY);
      if (painting) { if (h) strokeTo(h); else lastHit = null; }
      if (h && e.pointerType !== 'touch') {
        cursor.visible = true; cursor.position.copy(h.point);
        const s = mode === 'fill' ? 0.02 : brush.r; cursor.scale.set(s, s, s);
      } else cursor.visible = false;
    }
    function onPointerEnd(e) {
      active.delete(e.pointerId);
      if (painting && e.pointerId === activeId) stopStroke();
    }
    function onPointerLeave() { cursor.visible = false; }

    domElement.addEventListener('pointerdown', onPointerDown);
    domElement.addEventListener('pointermove', onPointerMove);
    domElement.addEventListener('pointerup', onPointerEnd);
    domElement.addEventListener('pointercancel', onPointerEnd);
    domElement.addEventListener('pointerleave', onPointerLeave);

    // ---------- public object ----------
    const painter = {
      cursor,
      onChange: null,
      hitAt,
      setColor(hex) { brush.hex = normHex(hex); cursor.material.color.set(brush.hex); return painter; },
      // Run fn(parts) that edits part canvases directly, as ONE undoable step (all parts are snapshotted first).
      transact(fn) {
        stopStroke(); beginStroke();
        parts.forEach(remember);
        fn(parts);
        parts.forEach(p => { p.tex.needsUpdate = true; });
        endStroke();
        return painter;
      },
      setSize(worldRadius) { brush.r = Math.max(0.001, Number(worldRadius) || 0.001); return painter; },
      setHardness(h) { brush.hardness = Math.min(1, Math.max(0, Number(h) || 0)); return painter; },
      undo() {
        const s = undoStack.pop();
        if (!s) return false;
        s.forEach((img, part) => { part.ctx.putImageData(img, 0, 0); part.tex.needsUpdate = true; });
        notify();
        return true;
      },
      reset() {
        stopStroke();
        beginStroke();
        parts.forEach(p => { remember(p); p.ctx.fillStyle = '#ffffff'; p.ctx.fillRect(0, 0, p.W, p.H); p.tex.needsUpdate = true; });
        endStroke();
      },
      canUndo() { return undoStack.length > 0; },
      dispose() {
        stopStroke();
        domElement.removeEventListener('pointerdown', onPointerDown);
        domElement.removeEventListener('pointermove', onPointerMove);
        domElement.removeEventListener('pointerup', onPointerEnd);
        domElement.removeEventListener('pointercancel', onPointerEnd);
        domElement.removeEventListener('pointerleave', onPointerLeave);
        active.clear();
        cursor.visible = false;
        if (cursor.parent) cursor.parent.remove(cursor);
      }
    };
    Object.defineProperties(painter, {
      enabled: {
        enumerable: true,
        get() { return enabled; },
        set(v) { enabled = !!v; if (!enabled) { stopStroke(); cursor.visible = false; } }
      },
      mode: {
        enumerable: true,
        get() { return mode; },
        set(m) { if (m === 'brush' || m === 'fill') { mode = m; if (painting) stopStroke(); } }
      },
      color: { enumerable: true, get() { return brush.hex; }, set(v) { painter.setColor(v); } },
      size: { enumerable: true, get() { return brush.r; }, set(v) { painter.setSize(v); } },
      hardness: { enumerable: true, get() { return brush.hardness; }, set(v) { painter.setHardness(v); } },
      isPainting: { enumerable: true, get() { return painting; } }
    });
    return painter;
  }

  window.Paint = { createMannequin, createPainter, UNDO_MAX };
})();
