// api/cron/cleanup-blobs.js
import { list, del } from '@vercel/blob';

const TTL_MS = 24 * 60 * 60 * 1000;   // 有効期限: アップロードから24時間
const PREFIX = 'rooms/';
const TIME_BUDGET_MS = 50 * 1000;      // 関数のタイムアウト前に切り上げる

export async function GET(request) {
    // Vercel は CRON_SECRET を設定すると Authorization: Bearer <値> を付けて呼ぶ
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
        return new Response('Unauthorized', { status: 401 });
    }

    const started = Date.now();
    const threshold = started - TTL_MS;
    let cursor, deleted = 0, done = true;

    do {
        const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
        const expired = page.blobs
            .filter((b) => new Date(b.uploadedAt).getTime() < threshold)
            .map((b) => b.url);
        if (expired.length) { await del(expired); deleted += expired.length; }
        cursor = page.hasMore ? page.cursor : undefined;
        if (cursor && Date.now() - started > TIME_BUDGET_MS) { done = false; break; }  // 残りは次回
    } while (cursor);

    return Response.json({ deleted, done });
}