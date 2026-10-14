// POST /api/action { code, playerId, token, type, ... } → { room }
import { advance, applyAction, checkToken, findPlayer, normalizeCode, publicView, GameError } from '../lib/game.js';
import { getRoom, saveRoom, withLock, touch, seenMap } from '../lib/store.js';
import { json, readJson, handleError } from '../lib/http.js';

export async function POST(request) {
  try {
    const body = await readJson(request);
    const code = normalizeCode(body.code);
    if (!code) throw new GameError(400, '部屋コードが正しくありません');
    if (typeof body.type !== 'string') throw new GameError(400, '操作の種類がありません');

    const room = await withLock(code, async () => {
      const r = await getRoom(code);
      if (!r) throw new GameError(404, '部屋が見つかりません');
      const player = findPlayer(r, body.playerId);
      if (!player || !checkToken(player, body.token)) throw new GameError(403, '参加者の確認ができませんでした');
      const now = Date.now();
      const before = r.version;
      try {
        applyAction(r, player, body, now);
      } catch (err) {
        // 操作は失敗しても、時間による切り替えが起きていれば保存しておく
        if (r.version !== before) await saveRoom(r);
        throw err;
      }
      await saveRoom(r);
      return r;
    });

    if (body.type !== 'leave') await touch(code, body.playerId);
    const seen = await seenMap(code);
    return json({ room: publicView(room, seen, Date.now()) });
  } catch (err) {
    return handleError(err);
  }
}
