// API 共通の小物
import { GameError } from './game.js';
import { LockTimeoutError } from './store.js';

export const MAX_JSON_BYTES = 256 * 1024;

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export const errorResponse = (status, message) => json({ error: message }, status);

/** 例外を JSON のエラー応答にする */
export function handleError(err) {
  if (err instanceof GameError) return errorResponse(err.status, err.message);
  if (err instanceof LockTimeoutError) return errorResponse(503, err.message);
  console.error(err);
  return errorResponse(500, 'サーバーでエラーが起きました');
}

/** 本文を JSON として読む。壊れていれば GameError(400) */
export async function readJson(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > MAX_JSON_BYTES) throw new GameError(413, '送信データが大きすぎます');
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new GameError(413, '送信データが大きすぎます');
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new GameError(400, 'JSON の形式が正しくありません');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new GameError(400, 'JSON の形式が正しくありません');
  return body;
}
