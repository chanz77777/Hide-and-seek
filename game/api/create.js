// POST /api/create { name } → { code, playerId, token, room }
import { createPlayer, createRoom, generateCode, publicView, GameError } from '../lib/game.js';
import { getRoom, saveRoom, withLock, touch, seenMap } from '../lib/store.js';
import { json, readJson, handleError } from '../lib/http.js';

export async function POST(request) {
  try {
    const body = await readJson(request);
    const now = Date.now();
    const host = createPlayer(body.name, now);
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = generateCode();
      const room = await withLock(code, async () => {
        if (await getRoom(code)) return null; // 使用中。別のコードで再試行
        const r = createRoom(code, host, now);
        await saveRoom(r);
        return r;
      });
      if (!room) continue;
      await touch(code, host.id);
      const seen = await seenMap(code);
      return json({ code, playerId: host.id, token: host.token, room: publicView(room, seen, Date.now()) });
    }
    throw new GameError(503, '部屋を作れませんでした。もう一度お試しください');
  } catch (err) {
    return handleError(err);
  }
}
