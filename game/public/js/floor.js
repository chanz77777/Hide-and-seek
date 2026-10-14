/*
 * floor.js - procedural floor artwork for the hide-and-seek game.
 *
 * Layers (bottom to top):
 *   1. Warm paper fill, then large overlapping soft color blobs in 8 hues so
 *      no flat background is visible anywhere.
 *   2. Main emoji layer: jittered grid of large (0.7-1.6 unit) rotated glyphs.
 *   3. Gap-filler layer: jittered grid of small (0.4-0.65 unit) rotated glyphs.
 *   Shadows and gradients are intentionally avoided: they made generation take
 *   several seconds on 4096x3072. Default texture is 2048x1536 (128 px / unit).
 *
 * Exposes window.Floor.generate({ texW, texH, seed, worldW, worldH })
 * -> { canvas, seed }. Deterministic per seed (mulberry32 PRNG).
 */
(function () {
  'use strict';

  var EMOJI = [
    // food
    '🍕', '🍎', '🍩', '🍣', '🍔', '🍓', '🍌', '🍉', '🥐', '🍦', '🍪', '🥕', '🍇', '🌽', '🍋',
    // people / faces
    '🧑', '👩', '👨', '🧒', '👶', '🙂', '😺',
    // animals
    '🐱', '🐶', '🐸', '🐟', '🐢', '🐰', '🦊', '🐼', '🐥', '🦋',
    // objects
    '🚗', '🚲', '⚽', '🎈', '📚', '☂️', '🎸', '🎁', '🧸', '🔑', '⏰', '🎩', '👟', '🧢', '💡',
    // nature / shapes
    '⭐', '🌸', '🌻', '🍀', '🌈', '❤️', '💙', '💛', '🔶', '🔷'
  ];

  var BLOB_HUES = [0, 25, 50, 120, 200, 230, 275, 330]; // red orange yellow green cyan blue purple pink

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function emojiFont(px) {
    return px + 'px "Segoe UI Emoji","Apple Color Emoji","Noto Color Emoji",sans-serif';
  }

  // Layer 1: paper tone + big overlapping soft color blobs.
  function paintBackground(ctx, rnd, texW, texH, ppu) {
    ctx.fillStyle = '#f3e4c4';
    ctx.fillRect(0, 0, texW, texH);
    var count = Math.ceil((texW / ppu) * (texH / ppu) * 0.2);
    for (var i = 0; i < count; i++) {
      var hue = BLOB_HUES[(rnd() * BLOB_HUES.length) | 0] + (rnd() - 0.5) * 20;
      var rx = ppu * (1.2 + rnd() * 2.2);
      var ry = ppu * (1.2 + rnd() * 2.2);
      var x = rnd() * texW;
      var y = rnd() * texH;
      ctx.fillStyle = 'hsla(' + hue + ',' + (65 + rnd() * 25) + '%,' + (55 + rnd() * 15) + '%,0.75)';
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Jittered-grid emoji pass. cell/sizes are in world units.
  function paintGlyphs(ctx, rnd, texW, texH, ppu, cell, minSize, maxSize, shadow) {
    var cellPx = cell * ppu;
    var cols = Math.ceil(texW / cellPx) + 1;
    var rows = Math.ceil(texH / cellPx) + 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 6;
      ctx.shadowOffsetX = 2;
      ctx.shadowOffsetY = 2;
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0)';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    var n = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var x = (c + rnd()) * cellPx - cellPx * 0.5;
        var y = (r + rnd()) * cellPx - cellPx * 0.5;
        var size = minSize + rnd() * (maxSize - minSize);
        var px = size * ppu;
        var glyph = EMOJI[(rnd() * EMOJI.length) | 0];
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(rnd() * Math.PI * 2);
        ctx.font = emojiFont(Math.round(px));
        ctx.fillText(glyph, 0, 0);
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        n++;
      }
    }
    return n;
  }

  function generate(opts) {
    opts = opts || {};
    var texW = opts.texW || 2048;
    var texH = opts.texH || 1536;
    var seed = (opts.seed === undefined) ? 1 : opts.seed;
    var worldW = opts.worldW || 16;
    var worldH = opts.worldH || 12;
    var ppu = texW / worldW; // pixels per world unit (worldH used for aspect sanity only)
    if (Math.abs(texH / worldH - ppu) > 1e-6) {
      ppu = Math.min(ppu, texH / worldH);
    }
    var rnd = mulberry32(seed);

    var canvas = document.createElement('canvas');
    canvas.width = texW;
    canvas.height = texH;
    var ctx = canvas.getContext('2d');

    paintBackground(ctx, rnd, texW, texH, ppu);
    paintGlyphs(ctx, rnd, texW, texH, ppu, 1.2, 0.8, 1.6, false);  // main layer (~130 glyphs)
    paintGlyphs(ctx, rnd, texW, texH, ppu, 1.4, 0.4, 0.7, false);  // gap filler (~100 glyphs)
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'rgba(0,0,0,0)';

    return { canvas: canvas, seed: seed };
  }

  window.Floor = { generate: generate, EMOJI: EMOJI };
})();
