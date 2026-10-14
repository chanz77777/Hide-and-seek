// POST /api/join { code, name } → { playerId, token, room }
import { addPlayer, advance, createPlayer, normalizeCode, publicView, GameError } from '../lib/game.js';
import { getRoom, saveRoom, withLock, touch, seenMap } from '../lib/store.js';
import { json, readJson, handleError } from '../lib/http.js';

export async function POST(request) {
  try {
    const body = await readJson(request);
    const code = normalizeCode(body.code);
    if (!code) throw new GameError(400, '部屋コードが正しくありません');
    const now = Date.now();
    const player = createPlayer(body.name, now);
    const room = await withLock(code, async () => {
      const r = await getRoom(code);
      if (!r) throw new GameError(404, '部屋が見つかりません');
      advance(r, now);
      addPlayer(r, player); // ロビー以外で参加した人は次のラウンドから（hiders には入らない）
      await saveRoom(r);
      return r;
    });
    await touch(code, player.id);
    const seen = await seenMap(code);
    return json({ playerId: player.id, token: player.token, room: publicView(room, seen, Date.now()) });
  } catch (err) {
    return handleError(err);
  }
}
