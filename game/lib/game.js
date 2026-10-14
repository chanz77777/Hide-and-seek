// ゲームのルール（I/O なし。単体テストしやすいよう純粋なロジックだけを置く）。
// 仕様: docs/online-protocol.md
import { randomBytes, randomInt } from 'node:crypto';

export const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // I と O を除く 24 文字
export const DEFAULT_PREP_SECONDS = 90;
export const DEFAULT_SEEK_SECONDS = 60;
export const MIN_SECONDS = 10;
export const MAX_SECONDS = 300;
export const PREP_GRACE_MS = 3000;
export const ONLINE_WINDOW_MS = 10000;
export const BOMB_RADIUS = 0.2;
export const BOMBS_PER_HIDER = 3;
export const MAX_OUTLINE_POINTS = 600;
export const MAX_NAME_LENGTH = 16;
export const MAX_URL_LENGTH = 500;
export const MAX_PLAYERS = 10;
export const X_LIMIT = 9; // 床は −8〜8。少し余裕を持たせる
export const Z_LIMIT = 7; // 床は −6〜6

export class GameError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GameError';
    this.status = status;
  }
}
const fail = (status, message) => {
  throw new GameError(status, message);
};

// ---------- 生成 ----------

export function generateCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  return s;
}

/** 部屋コードの正規化。形式が違えば null */
export function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const c = code.trim().toUpperCase();
  if (c.length !== 4) return null;
  for (const ch of c) if (!CODE_LETTERS.includes(ch)) return null;
  return c;
}

export function createPlayer(name, now) {
  return {
    id: randomBytes(9).toString('base64url'), // 12 文字
    token: randomBytes(18).toString('base64url'), // 24 文字
    name: validateName(name),
    joinedAt: now,
  };
}

export function createRoom(code, host, now) {
  return {
    code,
    version: 1,
    createdAt: now,
    phase: 'lobby',
    hostId: host.id,
    seekerId: host.id,
    round: 0,
    floorUrl: '',
    prepSeconds: DEFAULT_PREP_SECONDS,
    seekSeconds: DEFAULT_SEEK_SECONDS,
    prepEndsAt: 0,
    seekEndsAt: 0,
    players: [host],
    hiders: [],
    bombRadius: BOMB_RADIUS,
    bombsTotal: 0,
    bombsLeft: 0,
    bombs: [],
    result: null,
  };
}

export function addPlayer(room, player) {
  if (room.players.length >= MAX_PLAYERS) fail(409, `この部屋は満員です（${MAX_PLAYERS} 人まで）`);
  room.players.push(player);
  room.version++;
}

export function findPlayer(room, playerId) {
  if (typeof playerId !== 'string') return null;
  return room.players.find((p) => p.id === playerId) || null;
}

/** token を定数時間で比較 */
export function checkToken(player, token) {
  if (!player || typeof token !== 'string' || typeof player.token !== 'string') return false;
  const a = Buffer.from(player.token);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------- 入力検証 ----------

export function validateName(name) {
  if (typeof name !== 'string') fail(400, '名前を入力してください');
  // 制御文字は取り除く
  const n = name.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const len = [...n].length;
  if (len < 1) fail(400, '名前を入力してください');
  if (len > MAX_NAME_LENGTH) fail(400, `名前は ${MAX_NAME_LENGTH} 文字までです`);
  return n;
}

export function validateUrl(url, label = 'URL') {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_LENGTH) fail(400, `${label}が正しくありません`);
  if (!(url.startsWith('https://') || url.startsWith('/uploads/'))) fail(400, `${label}が正しくありません`);
  if (/[\s"'<>\\]/.test(url) || url.includes('..')) fail(400, `${label}が正しくありません`);
  return url;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function validateNumber(v, label) {
  if (!isNum(v)) fail(400, `${label}が正しくありません`);
  return v;
}

function validateX(v) {
  validateNumber(v, 'x');
  if (v < -X_LIMIT || v > X_LIMIT) fail(400, 'x が床の範囲外です');
  return v;
}

function validateZ(v) {
  validateNumber(v, 'z');
  if (v < -Z_LIMIT || v > Z_LIMIT) fail(400, 'z が床の範囲外です');
  return v;
}

function validateOutline(outline) {
  if (!Array.isArray(outline) || outline.length === 0) fail(400, 'outline が正しくありません');
  if (outline.length > MAX_OUTLINE_POINTS) fail(400, `outline は ${MAX_OUTLINE_POINTS} 点までです`);
  return outline.map((p) => {
    if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])) fail(400, 'outline の点が正しくありません');
    return [round3(p[0]), round3(p[1])];
  });
}

function validateSeconds(v, label) {
  if (v === undefined || v === null) return null;
  if (!isNum(v)) fail(400, `${label}が正しくありません`);
  const s = Math.round(v);
  if (s < MIN_SECONDS || s > MAX_SECONDS) fail(400, `${label}は ${MIN_SECONDS}〜${MAX_SECONDS} 秒です`);
  return s;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------- 状態遷移 ----------

function finish(room, reason) {
  room.phase = 'result';
  room.result = {
    reason,
    found: room.hiders.filter((h) => h.found).length,
    total: room.hiders.length,
  };
}

function startSeek(room, now) {
  room.hiders = room.hiders.filter((h) => h.submitted);
  if (room.hiders.length === 0) {
    room.bombsTotal = 0;
    room.bombsLeft = 0;
    finish(room, 'no-hiders');
    return;
  }
  room.phase = 'seek';
  room.bombsTotal = room.hiders.length * BOMBS_PER_HIDER;
  room.bombsLeft = room.bombsTotal;
  room.bombs = [];
  room.seekEndsAt = now + room.seekSeconds * 1000;
}

/** 1 段だけ進める。変化があれば true */
function step(room, now) {
  if (room.phase === 'prep') {
    const allSubmitted = room.hiders.every((h) => h.submitted);
    if (allSubmitted || now >= room.prepEndsAt + PREP_GRACE_MS) {
      startSeek(room, now);
      return true;
    }
  } else if (room.phase === 'seek') {
    if (room.hiders.length === 0) {
      finish(room, 'no-hiders');
      return true;
    }
    if (room.hiders.every((h) => h.found)) {
      finish(room, 'all-found');
      return true;
    }
    if (room.bombsLeft <= 0) {
      finish(room, 'no-bombs');
      return true;
    }
    if (now >= room.seekEndsAt) {
      finish(room, 'timeout');
      return true;
    }
  }
  return false;
}

/** 時間・状況による自動の切り替え。変化があれば version を上げて true */
export function advance(room, now) {
  let changed = false;
  for (let i = 0; i < 4 && step(room, now); i++) changed = true;
  if (changed) room.version++;
  return changed;
}

function requireHost(room, player) {
  if (room.hostId !== player.id) fail(403, 'ホストだけができる操作です');
}

function requirePhase(room, ...phases) {
  if (!phases.includes(room.phase)) fail(409, 'いまはその操作はできません');
}

function bombHits(hider, x, z, r) {
  const r2 = r * r;
  for (const [px, pz] of hider.outline || []) {
    const dx = px - x;
    const dz = pz - z;
    if (dx * dx + dz * dz <= r2) return true;
  }
  return false;
}

function removePlayer(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx < 0) return;
  room.players.splice(idx, 1);
  const wasHost = room.hostId === playerId;
  const wasSeeker = room.seekerId === playerId;
  if (wasHost) room.hostId = room.players[0] ? room.players[0].id : '';
  if (wasSeeker) {
    if (room.phase === 'prep' || room.phase === 'seek') finish(room, 'seeker-left');
    room.seekerId = room.hostId;
  }
  // 準備中に抜けた隠れる人はそのラウンドから外す（捜索中・結果では床に残す）
  if (room.phase === 'prep') room.hiders = room.hiders.filter((h) => h.id !== playerId);
}

/**
 * 操作を適用する。成功すれば room を書き換えて version を上げる。失敗は GameError を投げる。
 * 呼び出し前に advance しておくこと（ここでも念のため前後で advance する）。
 */
export function applyAction(room, player, action, now) {
  if (!player || !findPlayer(room, player.id)) fail(403, 'この部屋の参加者ではありません');
  if (!action || typeof action !== 'object') fail(400, '操作が正しくありません');
  advance(room, now);

  switch (action.type) {
    case 'set-floor': {
      requireHost(room, player);
      requirePhase(room, 'lobby');
      room.floorUrl = validateUrl(action.url, '床の画像の URL');
      break;
    }
    case 'set-seeker': {
      requireHost(room, player);
      requirePhase(room, 'lobby');
      const target = findPlayer(room, action.targetId);
      if (!target) fail(400, 'その参加者は見つかりません');
      room.seekerId = target.id;
      break;
    }
    case 'start': {
      requireHost(room, player);
      requirePhase(room, 'lobby');
      if (!room.floorUrl) fail(409, '床の画像が決まっていません');
      if (room.players.length < 2) fail(409, '2 人以上で始めてください');
      const prep = validateSeconds(action.prepSeconds, '準備時間');
      const seek = validateSeconds(action.seekSeconds, '捜索時間');
      if (prep !== null) room.prepSeconds = prep;
      if (seek !== null) room.seekSeconds = seek;
      if (!findPlayer(room, room.seekerId)) room.seekerId = room.hostId;
      room.phase = 'prep';
      room.round++;
      room.hiders = room.players
        .filter((p) => p.id !== room.seekerId)
        .map((p) => ({ id: p.id, name: p.name, submitted: false, found: false }));
      room.prepEndsAt = now + room.prepSeconds * 1000;
      room.seekEndsAt = 0;
      room.bombsTotal = 0;
      room.bombsLeft = 0;
      room.bombs = [];
      room.result = null;
      break;
    }
    case 'hidden': {
      requirePhase(room, 'prep');
      const h = room.hiders.find((x) => x.id === player.id);
      if (!h) fail(403, 'このラウンドの隠れる人ではありません');
      const x = validateX(action.x);
      const z = validateZ(action.z);
      const heading = validateNumber(action.heading, 'heading');
      const texUrl = validateUrl(action.texUrl, '体の塗りの URL');
      const outline = validateOutline(action.outline);
      Object.assign(h, { submitted: true, x: round3(x), z: round3(z), heading, texUrl, outline });
      break;
    }
    case 'bomb': {
      requirePhase(room, 'seek');
      if (room.seekerId !== player.id) fail(403, '見つける人だけが爆撃できます');
      if (room.bombsLeft <= 0) fail(409, '爆弾が残っていません');
      const x = validateX(action.x);
      const z = validateZ(action.z);
      const hitIds = room.hiders.filter((h) => !h.found && bombHits(h, x, z, room.bombRadius)).map((h) => h.id);
      for (const h of room.hiders) if (hitIds.includes(h.id)) h.found = true;
      room.bombs.push({ x: round3(x), z: round3(z), hit: hitIds.length > 0, hitIds });
      room.bombsLeft--;
      break;
    }
    case 'to-lobby': {
      requireHost(room, player);
      requirePhase(room, 'result');
      room.phase = 'lobby';
      room.hiders = [];
      room.bombs = [];
      room.bombsTotal = 0;
      room.bombsLeft = 0;
      room.prepEndsAt = 0;
      room.seekEndsAt = 0;
      room.result = null;
      if (!findPlayer(room, room.seekerId)) room.seekerId = room.hostId;
      break;
    }
    case 'leave': {
      removePlayer(room, player.id);
      break;
    }
    default:
      fail(400, '知らない操作です');
  }
  room.version++;
  advance(room, now);
  return room;
}

// ---------- 公開形 ----------

export function publicView(room, seen = {}, now = Date.now()) {
  const showPos = room.phase === 'seek' || room.phase === 'result';
  return {
    code: room.code,
    version: room.version,
    phase: room.phase,
    serverNow: now,
    hostId: room.hostId,
    seekerId: room.seekerId,
    round: room.round,
    floorUrl: room.floorUrl,
    prepSeconds: room.prepSeconds,
    seekSeconds: room.seekSeconds,
    prepEndsAt: room.prepEndsAt,
    seekEndsAt: room.seekEndsAt,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.id === room.seekerId ? 'seeker' : 'hider',
      isHost: p.id === room.hostId,
      online: typeof seen[p.id] === 'number' && now - seen[p.id] <= ONLINE_WINDOW_MS,
    })),
    hiders: room.hiders.map((h) => {
      const v = { id: h.id, name: h.name, submitted: !!h.submitted, found: !!h.found };
      if (showPos && h.submitted) {
        v.x = h.x;
        v.z = h.z;
        v.heading = h.heading;
        v.texUrl = h.texUrl;
      }
      return v;
    }),
    bombRadius: room.bombRadius,
    bombsTotal: room.bombsTotal,
    bombsLeft: room.bombsLeft,
    bombs: room.bombs.map((b) => ({ x: b.x, z: b.z, hit: b.hit, hitIds: [...b.hitIds] })),
    result: room.result ? { ...room.result } : null,
  };
}
