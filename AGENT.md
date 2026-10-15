# Agent Instructions & Project Overview

## 1. Project Overview
- **Core Purpose**: 画像や生成テクスチャの床の上にマネキンアバターをカモフラージュ塗装して隠れ、見つける側が爆撃して捜索する非対称対戦型Webゲーム「お絵描きかくれんぼ」。ローカル対戦（1台交代 / BroadcastChannelによる別タブ間連携）およびオンライン対戦（ルーム制）に対応。
- **Tech Stack**: 
  - Language: JavaScript (ES Modules / Node.js >= 20)
  - Frontend: Vanilla HTML5 / CSS3 / JavaScript (ビルドツール不要のネイティブESM), Three.js r158 (UMD, `public/vendor/` に同梱)
  - Backend / API: Node.js (標準ライブラリ中心のゼロ外部フレームワーク), Vercel Serverless Functions (`api/`)
  - Storage / DB: Upstash Redis (`@upstash/redis`), Vercel Blob (`@vercel/blob`) ※ローカル開発時はインメモリおよびローカルファイル保存に自動フォールバック
- **Architecture Style**: 
  - フロントエンド: フレームワーク非依存のVanilla JS + Three.jsによる3D/2Dハイブリッド描画アーキテクチャ。
  - バックエンド: I/Oを排除した純粋関数中心のドメインロジック（`lib/game.js`）と、ストレージ抽象化層（`lib/store.js`, `lib/blob.js`）、薄いVercel Functionハンドラー（`api/`）に分離されたレイヤードアーキテクチャ。

## 2. Directory Structure
```text
.
├── docs/                        # プロジェクト計画・画像リソース・企画仕様書
│   ├── game-plan.html           # ゲーム企画・仕様詳細ドキュメント
│   └── img/                     # 仕様図・コンセプトSVG画像
├── game/                        # ゲーム本体のソースコードおよび実行環境
│   ├── api/                     # Vercel Serverless Function エンドポイント
│   │   ├── action.js            # ラウンド開始、爆撃、ロビー移動等のゲーム内アクション
│   │   ├── create.js            # 部屋作成
│   │   ├── cursor.js            # 見つける人のリアルタイム照準カーソル同期
│   │   ├── join.js              # 部屋参加
│   │   ├── state.js             # 部屋状態取得・ロングポーリング
│   │   └── upload.js            # 床テクスチャ・マネキン塗装画像のアップロード
│   ├── dev/                     # ローカル開発・検証用スクリプト
│   │   ├── server.mjs           # 静的配信 + APIルーティング対応のローカルHTTPサーバー
│   │   └── test-api.mjs         # API・ゲーム進行のE2Eテストスイート (82テスト)
│   ├── docs/                    # ゲーム詳細仕様ドキュメント
│   │   └── online-protocol.md   # オンライン対戦プロトコル・API仕様
│   ├── lib/                     # バックエンド共通ライブラリ・ドメインモデル
│   │   ├── blob.js              # 画像ストレージ抽象化（Vercel Blob / ローカルファイル）
│   │   ├── game.js              # ゲームの純粋ドメインロジック（判定・ステートマシン・バリデーション）
│   │   ├── http.js              # HTTPレスポンス生成・エラーハンドリング・JSONパース
│   │   └── store.js             # ルーム状態の永続化抽象化（Upstash Redis / メモリキャッシュ）
│   ├── public/                  # フロントエンド公開静的ファイル
│   │   ├── index.html           # ゲーム画面骨組み（HUD・モーダル・UIスタイル・Canvas）
│   │   ├── js/
│   │   │   ├── floor.js         # 床テクスチャ生成（絵文字敷き詰めアルゴリズム）
│   │   │   ├── link.js          # 同一PC内別タブ連携（BroadcastChannel）
│   │   │   ├── main.js          # メインループ（移動、カメラ、ミニマップ、爆撃、当たり判定、演出）
│   │   │   ├── online.js        # オンライン対戦通信・ポーリング・ロビー・ラウンド進行
│   │   │   └── paint.js         # 3Dマネキン生成・テクスチャペイント・一括擬態ロジック
│   │   └── vendor/
│   │       └── three.min.js     # Three.js r158 ライブラリ
│   ├── package.json             # プロジェクト定義・依存関係
│   ├── DEPLOY.md                # Vercel / Upstash デプロイ手順書
│   └── README.md                # ゲームルール、操作方法、開発用URLフラグ説明書
└── AGENT.md                     # 本ファイル（AI用コンテキスト・ルール定義）
```

## 3. Core Rules & Constraints (AIへの指示・禁止事項)
- **Do's (推奨する方針)**:
  - **ゼロビルド原則の維持**: フロントエンドはトランスパイルやバンドラー（Vite, Webpack等）を介さず、ブラウザが直接実行できるVanilla JS/CSS/HTMLを維持すること。
  - **ドメインロジックの純粋性維持**: ルール計算や当たり判定、状態遷移などのコアロジックは `lib/game.js` に集約し、I/O（DBアクセスやHTTPリクエスト）から完全に切り離して単体テスト可能に保つこと。
  - **環境変数フォールバックの尊重**: Redis / Blob の設定がない場合でも `dev/server.mjs` および `npm test` がスタンドアロンで完全動作するフォールバック設計を壊さないこと。
  - **URLフラグを活用したテスト**: 画面開発・検証時は `index.html#start,paint` や `index.html#seek` などの既存デバッグハッシュを活用すること。

- **Don'ts (禁止事項)**:
  - **勝手な外部ライブラリ・UIフレームワークの追加禁止**: React, Vue, Tailwind CSS, Axios, Express 等を勝手に追加・導入しないこと（Node.js標準APIおよび既存ライブラリ `@upstash/redis`, `@vercel/blob`, `Three.js` のみを使用）。
  - **TypeScriptへの無断移行禁止**: 型定義なしの素のJavaScript（ES Modules）で統一されているため、`.ts` や `.tsx` ファイルを勝手に導入しないこと。
  - **秘密情報・トークンの露出禁止**: プレイヤーの `token` や、隠れるフェーズ中のプレイヤー座標・テクスチャ・当たり判定アウトライン情報を、権限のないプレイヤー（見つける人）向けのレスポンスに露出させないこと（チート防止仕様を厳守）。

## 4. Coding Style & Conventions
- **Naming Conventions**:
  - ファイル名: フロントエンドおよびライブラリは小文字ケバブケースまたはシンプル名（例: `online-protocol.md`, `test-api.mjs`, `floor.js`, `main.js`）。
  - 定数: `UPPER_SNAKE_CASE`（例: `DEFAULT_PREP_SECONDS`, `BOMB_RADIUS`, `MAX_PLAYERS`）。
  - 関数・変数: `camelCase`（例: `createPlayer`, `checkHit`, `handleError`）。
  - クラス名: `PascalCase`（例: `GameError`, `LockTimeoutError`）。
- **Module System**:
  - 全て ES Modules (`"type": "module"`, `import` / `export`) を使用すること。CommonJS (`require` / `module.exports`) は使用しない。
- **Error Handling**:
  - ドメインエラーは `lib/game.js` の `GameError(status, message)` をスローする。
  - API層では `lib/http.js` の `handleError(err)` を介して適切なステータスコードと統一された `{ error: message }` 形式のJSONを返却する。

## 5. Common Commands
作業ディレクトリは `game/` 配下です。
- 依存関係インストール: `cd game && npm install`
- ローカル開発サーバー起動: `cd game && npm run dev`
  - アクセス先: `http://localhost:3000`（静的ファイル配信と `/api/*` のモック実行）
- 自動E2Eテスト実行: `cd game && npm test`
  - `dev/test-api.mjs` により、インメモリ環境でルーム生成〜隠れる〜捜索〜結果〜交代の全APIシーケンス（80項目以上）を網羅検証
