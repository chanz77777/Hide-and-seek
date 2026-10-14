// GET /api/state?code=&playerId=&v= → { room, cursor } | { unchanged: true, serverNow, cursor }
import { advance, findPlayer, normalizeCode, publicView, GameError } from '../lib/game.js';
import { getRoom, saveRoom, withLock, touch, seenMap, getCursor } from '../lib/store.js';
import { json, handleError } from '../lib/http.js';

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const code = normalizeCode(params.get('code'));
    if (!code) throw new GameError(400, '部屋コードが正しくありません');
    const playerId = params.get('playerId') || '';
    const clientVersion = params.get('v');

    // まずロック無しで読む（ポーリングは読み取りが大半なので）。
    // 時間による切り替えが必要なときだけ、ロックを取って読み直してから進めて保存する。
    let room = await getRoom(code);
    if (!room) throw new GameError(404, '部屋が見つかりません');
    let advanced = false;
    if (advance(structuredClone(room), Date.now())) {
      room = await withLock(code, async () => {
        const r = await getRoom(code);
        if (!r) throw new GameError(404, '部屋が見つかりません');
        if (advance(r, Date.now())) {
          await saveRoom(r);
          advanced = true;
        }
        return r;
      });
    }

    if (playerId && findPlayer(room, playerId)) await touch(code, playerId);

    const now = Date.now();
    // 捜索中は見つける人の照準も返す（version に関係なく毎回）
    const cursor = room.phase === 'seek' ? await getCursor(code) : null;
    if (!advanced && clientVersion !== null && clientVersion === String(room.version)) {
      return json({ unchanged: true, serverNow: now, cursor });
    }
    const seen = await seenMap(code);
    return json({ room: publicView(room, seen, now), cursor });
  } catch (err) {
    return handleError(err);
  }
}
