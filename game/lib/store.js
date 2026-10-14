// 部屋の保存先。Upstash Redis の環境変数があれば Redis、無ければメモリ（ローカル開発専用）。
import { randomBytes } from 'node:crypto';
import { Redis } from '@upstash/redis';

export const ROOM_TTL_SECONDS = 3 * 60 * 60;
export const CURSOR_TTL_MS = 10 * 1000;
const cursorKey = (code) => `cursor:${code}`;
const LOCK_TTL_MS = 3000;
const LOCK_RETRY_MS = 50;
const LOCK_WAIT_MS = 3000;

const roomKey = (code) => `room:${code}`;
const lockKey = (code) => `lock:${code}`;
const seenKey = (code) => `seen:${code}`;

export class LockTimeoutError extends Error {
  constructor() {
    super('サーバーが混み合っています。もう一度お試しください');
    this.name = 'LockTimeoutError';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function redisConfig() {
  const env = process.env;
  if (env.KV_REST_API_URL && env.KV_REST_API_TOKEN) {
    return { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN };
  }
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN };
  }
  return null;
}

function createRedisStore(cfg) {
  // automaticDeserialization を切り、JSON は自前で扱う（型のぶれを避ける）
  const redis = new Redis({ url: cfg.url, token: cfg.token, automaticDeserialization: false });
  return {
    kind: 'redis',
    async getRoom(code) {
      const raw = await redis.get(roomKey(code));
      if (raw == null) return null;
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    },
    async saveRoom(room) {
      await redis.set(roomKey(room.code), JSON.stringify(room), { ex: ROOM_TTL_SECONDS });
    },
    async withLock(code, fn) {
      const key = lockKey(code);
      const value = randomBytes(12).toString('base64url');
      const deadline = Date.now() + LOCK_WAIT_MS;
      for (;;) {
        const ok = await redis.set(key, value, { nx: true, px: LOCK_TTL_MS });
        if (ok === 'OK' || ok === true) break;
        if (Date.now() >= deadline) throw new LockTimeoutError();
        await sleep(LOCK_RETRY_MS);
      }
      try {
        return await fn();
      } finally {
        // 自分が取ったロックのときだけ消す
        try {
          await redis.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            [key],
            [value],
          );
        } catch (e) {
          console.error('lock release failed', e);
        }
      }
    },
    async touch(code, playerId) {
      const key = seenKey(code);
      await redis.hset(key, { [playerId]: String(Date.now()) });
      await redis.expire(key, ROOM_TTL_SECONDS);
    },
    async seenMap(code) {
      const h = await redis.hgetall(seenKey(code));
      const out = {};
      if (h) for (const [k, v] of Object.entries(h)) out[k] = Number(v) || 0;
      return out;
    },
    async setCursor(code, cursor) {
      await redis.set(cursorKey(code), JSON.stringify(cursor), { px: CURSOR_TTL_MS });
    },
    async getCursor(code) {
      const raw = await redis.get(cursorKey(code));
      if (!raw) return null;
      try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
    },
  };
}

function createMemoryStore() {
  const rooms = new Map(); // code -> { json, expiresAt }
  const seen = new Map(); // code -> { map: Map, expiresAt }
  const chains = new Map(); // code -> Promise
  const cursors = new Map(); // code -> { cursor, expiresAt }
  const alive = (e) => e && e.expiresAt > Date.now();
  return {
    kind: 'memory',
    async getRoom(code) {
      const e = rooms.get(code);
      if (!alive(e)) {
        rooms.delete(code);
        return null;
      }
      return JSON.parse(e.json);
    },
    async saveRoom(room) {
      rooms.set(room.code, { json: JSON.stringify(room), expiresAt: Date.now() + ROOM_TTL_SECONDS * 1000 });
    },
    async withLock(code, fn) {
      const prev = chains.get(code) || Promise.resolve();
      const run = prev.then(() => fn());
      const tail = run.catch(() => {});
      chains.set(code, tail);
      tail.then(() => {
        if (chains.get(code) === tail) chains.delete(code);
      });
      return run;
    },
    async touch(code, playerId) {
      let e = seen.get(code);
      if (!alive(e)) {
        e = { map: new Map() };
        seen.set(code, e);
      }
      e.map.set(playerId, Date.now());
      e.expiresAt = Date.now() + ROOM_TTL_SECONDS * 1000;
    },
    async seenMap(code) {
      const e = seen.get(code);
      return alive(e) ? Object.fromEntries(e.map) : {};
    },
    async setCursor(code, cursor) {
      cursors.set(code, { cursor, expiresAt: Date.now() + CURSOR_TTL_MS });
    },
    async getCursor(code) {
      const e = cursors.get(code);
      return alive(e) ? e.cursor : null;
    },
  };
}

let store = null;
function getStore() {
  if (store) return store;
  const cfg = redisConfig();
  if (cfg) {
    store = createRedisStore(cfg);
  } else {
    console.warn('[store] Redis の環境変数が無いため、メモリ保存を使います（ローカル開発専用。再起動で消えます）');
    store = createMemoryStore();
  }
  return store;
}

export const getRoom = (code) => getStore().getRoom(code);
export const saveRoom = (room) => getStore().saveRoom(room);
export const withLock = (code, fn) => getStore().withLock(code, fn);
export const touch = (code, playerId) => getStore().touch(code, playerId);
export const seenMap = (code) => getStore().seenMap(code);
// 見つける人の照準（捜索中だけ使う。部屋の version は変えない一時データ）
export const setCursor = (code, cursor) => getStore().setCursor(code, cursor);
export const getCursor = (code) => getStore().getCursor(code);
