// 画像の保存先。BLOB_READ_WRITE_TOKEN があれば Vercel Blob、無ければ dev/.data/uploads/ に書く。
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_UPLOAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dev', '.data', 'uploads');

export async function putImage(pathname, buffer, contentType) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const { put } = await import('@vercel/blob');
    const res = await put(pathname, buffer, {
      access: 'public',
      addRandomSuffix: true,
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    return res.url;
  }
  const safe = String(pathname).split('/').filter((s) => s && s !== '.' && s !== '..');
  const file = path.join(LOCAL_UPLOAD_DIR, ...safe);
  if (!file.startsWith(LOCAL_UPLOAD_DIR + path.sep)) throw new Error('invalid pathname');
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, buffer);
  return '/uploads/' + safe.join('/');
}
