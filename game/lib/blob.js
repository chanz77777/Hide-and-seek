// 画像の保存先。Vercel 上では Vercel Blob、ローカル開発では dev/.data/uploads/ に書く。
// Blob の認証は SDK に任せる（OIDC: BLOB_STORE_ID + VERCEL_OIDC_TOKEN、または BLOB_READ_WRITE_TOKEN）。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GameError } from './game.js';

export const LOCAL_UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', '.data', 'uploads');

const hasBlobConfig = () => !!(process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN);

export async function putImage(pathname, buffer, contentType) {
  if (hasBlobConfig()) {
    const { put } = await import('@vercel/blob');
    try {
      const res = await put(pathname, buffer, { access: 'public', addRandomSuffix: true, contentType });
      return res.url;
    } catch (err) {
      console.error('[blob] put failed:', err);
      throw new GameError(500, '画像の保存に失敗しました。Vercel Blob が Public のストアでつながっているか確認してください');
    }
  }
  // Vercel 上ではファイルを書けないので、ローカル保存に切り替えずにはっきりエラーにする
  if (process.env.VERCEL) {
    throw new GameError(500, '画像の保存先（Vercel Blob）がつながっていません');
  }
  const safe = String(pathname).split('/').filter((s) => s && s !== '.' && s !== '..');
  const file = path.join(LOCAL_UPLOAD_DIR, ...safe);
  if (!file.startsWith(LOCAL_UPLOAD_DIR + path.sep)) throw new Error('invalid pathname');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  return '/uploads/' + safe.join('/');
}
