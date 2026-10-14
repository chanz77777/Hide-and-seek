// POST /api/upload?code=&playerId=&token=&kind=floor|body  本文 = 生の画像 → { url }
import { checkToken, findPlayer, normalizeCode, GameError } from '../lib/game.js';
import { getRoom } from '../lib/store.js';
import { putImage } from '../lib/blob.js';
import { json, handleError } from '../lib/http.js';

export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };

/** 先頭バイトが申告された形式と合っているか */
function magicOk(type, b) {
  if (type === 'image/png') return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === 'image/jpeg') return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (type === 'image/webp') {
    return b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  }
  return false;
}

export async function POST(request) {
  try {
    const params = new URL(request.url).searchParams;
    const code = normalizeCode(params.get('code'));
    if (!code) throw new GameError(400, '部屋コードが正しくありません');
    const kind = params.get('kind');
    if (kind !== 'floor' && kind !== 'body') throw new GameError(400, 'kind は floor か body です');

    const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = EXT[type];
    if (!ext) throw new GameError(415, '画像は WebP・JPEG・PNG のいずれかにしてください');
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > MAX_UPLOAD_BYTES) throw new GameError(413, '画像は 4 MB までです');

    const room = await getRoom(code);
    if (!room) throw new GameError(404, '部屋が見つかりません');
    const player = findPlayer(room, params.get('playerId'));
    if (!player || !checkToken(player, params.get('token'))) throw new GameError(403, '参加者の確認ができませんでした');
    if (kind === 'floor' && room.hostId !== player.id) throw new GameError(403, '床の画像はホストだけが送れます');

    const buf = Buffer.from(await request.arrayBuffer());
    if (buf.length === 0) throw new GameError(400, '画像が空です');
    if (buf.length > MAX_UPLOAD_BYTES) throw new GameError(413, '画像は 4 MB までです');
    if (!magicOk(type, buf)) throw new GameError(415, '画像の中身が形式と合っていません');

    const pathname = `rooms/${code}/${kind}-${player.id}-${Date.now()}.${ext}`;
    const url = await putImage(pathname, buf, type);
    return json({ url });
  } catch (err) {
    return handleError(err);
  }
}
