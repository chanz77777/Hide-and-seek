# オンライン対戦 通信仕様（v1）

構成: 静的ファイル `public/` + Vercel Functions `api/*.js`（Node.js、Web 標準の `export async function GET/POST(request) → Response`）。
部屋の状態は Redis（Upstash）に JSON で保存し、クライアントは約 1 秒ごとにポーリングする。画像（床・体の塗り）は Vercel Blob。
環境変数が無いとき（ローカル開発）はメモリ保存 + ローカルフォルダ保存に自動で切り替わる。

## 環境変数

| 変数 | 用途 |
|---|---|
| `KV_REST_API_URL` / `KV_REST_API_TOKEN`（または `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`） | Upstash Redis。Vercel Marketplace の Upstash 連携で自動設定される |
| `BLOB_READ_WRITE_TOKEN` | Vercel Blob。Blob ストアをプロジェクトに接続すると自動設定される |

## 用語

- 部屋コード: 英大文字 4 文字（I と O を除く）。例 `KMTR`
- プレイヤー: `id`（ランダム 12 文字）と秘密の `token`（ランダム 24 文字）。token は自分にしか返さない
- 役割: `seeker`（1 人）/ `hider`（それ以外全員）
- 床の座標: 床は 16 × 12 unit、中心が原点。x は −8〜8、z は −6〜6

## 部屋の状態（GET で返す公開形）

```json
{
  "code": "KMTR", "version": 12, "phase": "lobby | prep | seek | result",
  "serverNow": 1760000000000,
  "hostId": "...", "seekerId": "...", "round": 1,
  "floorUrl": "https://... | /uploads/...", "prepSeconds": 90, "seekSeconds": 60,
  "prepEndsAt": 0, "seekEndsAt": 0,
  "players": [{ "id": "...", "name": "ゆうや", "role": "hider", "isHost": true, "online": true }],
  "hiders": [{ "id": "...", "name": "...", "submitted": true, "found": false,
               "x": 1.2, "z": -3.4, "heading": 0.6, "texUrl": "..." }],
  "bombRadius": 0.2, "bombsTotal": 6, "bombsLeft": 4,
  "bombs": [{ "x": 1.0, "z": 2.0, "hit": false, "hitIds": [] }],
  "result": null
}
```

- `hiders[].x / z / heading / texUrl` は `phase` が `seek` か `result` のときだけ入れる（準備中は位置を漏らさない）
- `outline`（命中判定用の点群）はサーバー内部だけで使い、返さない
- `online` は最後のアクセスから 10 秒以内なら true
- `result`: `{ "reason": "all-found | no-bombs | timeout | no-hiders | seeker-left", "found": 1, "total": 2 }`

## API

すべて JSON。エラーは `{ "error": "日本語のメッセージ" }` と 4xx。

| メソッド・パス | 入力 | 出力 |
|---|---|---|
| `POST /api/create` | `{ name }` | `{ code, playerId, token, room }`（作成者がホスト。最初の見つける人もホスト） |
| `POST /api/join` | `{ code, name }` | `{ playerId, token, room }`（ロビー以外で参加した人は次のラウンドから） |
| `GET /api/state?code=&playerId=&v=` | v = 手元の version | `{ room, cursor }`。version が同じなら `{ unchanged: true, serverNow, cursor }`。playerId があれば最終アクセス時刻を更新 |
| `POST /api/action` | `{ code, playerId, token, type, ... }` | `{ room }` |
| `POST /api/upload?code=&playerId=&token=&kind=floor|body` | 生の画像（`image/webp`・`image/jpeg`・`image/png`、4 MB まで） | `{ url }` |
| `POST /api/cursor` | `{ code, playerId, token, x, z }`（見つける人・捜索中のみ） | `{ ok: true }`。照準の位置を 10 秒だけ保存する。部屋の version は変えない |

捜索中は `GET /api/state` の応答に `cursor: { x, z, t }`（見つける人の照準。無ければ null）が付く。`unchanged: true` のときも付く。
クライアントは捜索中だけ 0.4 秒ごとに状態を取りに行き、見つける人は照準を 0.25 秒ごとに送る。

### action の種類

| type | 誰が / いつ | 追加の入力 | 効果 |
|---|---|---|---|
| `set-floor` | ホスト / lobby | `url` | 床の画像を決める |
| `set-seeker` | ホスト / lobby | `targetId` | 見つける人を決める |
| `start` | ホスト / lobby。床が決まっていて 2 人以上 | `prepSeconds`・`seekSeconds`（任意。10〜300） | prep へ。見つける人以外が全員 hider。round を 1 増やす |
| `hidden` | hider / prep | `x, z, heading, texUrl, outline: [[x,z], …]`（600 点まで） | 隠れた内容を登録（prep 中は上書き可） |
| `bomb` | seeker / seek。残り 1 発以上 | `x, z` | 未発見の hider の outline の点が 1 つでも半径 `bombRadius` 以内なら発見 |
| `to-lobby` | ホスト / result | — | lobby に戻る（参加者・床・見つける人はそのまま） |
| `leave` | 誰でも | — | 退出。ホストが抜けたら次の人がホスト。ゲーム中に見つける人が抜けたら result（seeker-left） |

### 時間による自動の切り替え（読み取り時・操作時に毎回判定）

- prep → seek: 全 hider が `hidden` を送った、または `prepEndsAt` から 3 秒過ぎた。送っていない hider はそのラウンドから外す。送った人が 0 人なら result（no-hiders）。
  `bombsTotal = 送った hider 数 × 3`、`seekEndsAt = 今 + seekSeconds`
- seek → result: 全員発見（all-found）、爆弾切れ（no-bombs）、`seekEndsAt` を過ぎた（timeout）

### 体の塗り画像（texUrl）の形式

7 パーツのテクスチャを 1 枚にまとめた画像。幅 1024、上から順に並べる（同じ行に収まる限り左から詰める）。

| パーツ | サイズ | 位置 (x, y) |
|---|---|---|
| head | 1024×512 | (0, 0) |
| neck | 512×128 | (0, 512) |
| torso | 1024×1024 | (0, 640) |
| armL / armR | 512×1024 | (0, 1664) / (512, 1664) |
| legL / legR | 512×1024 | (0, 2688) / (512, 2688) |

全体 1024×3712。WebP で送る。
