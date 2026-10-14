// POST /api/cursor { code, playerId, token, x, z } → { ok: true }
// 捜索中の見つける人の照準位置を共有する。部屋の version は変えず、10 秒で消える一時データに置く。
import { checkToken, findPlayer, normalizeCode, GameError, X_LIMIT, Z_LIMIT } from '../lib/game.js';
import { getRoom, setCursor } from '../lib/store.js';
import { json, readJson, handleError } from '../lib/http.js';

export async function POST(request) {
  try {
    const body = await readJson(request);
    const code = normalizeCode(body.code);
    if (!code) throw new GameError(400, '部屋コードが正しくありません');
    const x = Number(body.x), z = Number(body.z);
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > X_LIMIT || Math.abs(z) > Z_LIMIT) {
      throw new GameError(400, '位置が正しくありません');
    }
    const room = await getRoom(code);   // 読むだけなのでロックは取らない
    if (!room) throw new GameError(404, '部屋が見つかりません');
    const player = findPlayer(room, body.playerId);
    if (!player || !checkToken(player, body.token)) throw new GameError(403, '参加者の確認ができませんでした');
    if (room.phase !== 'seek' || room.seekerId !== player.id) throw new GameError(409, '今は照準を送れません');
    await setCursor(code, { x: Math.round(x * 1000) / 1000, z: Math.round(z * 1000) / 1000, t: Date.now() });
    return json({ ok: true });
  } catch (err) {
    return handleError(err);
  }
}
