# E.I.G 予約状況ビューア

長岡 Enjoy Indoor Golf (E.I.G) の hacomono 予約状況を、GitHub Pages 上の独自UIで見やすく表示する静的アプリ。

## 構成

```
GitHub Pages (docs/index.html)
      ↓ fetch (リアルタイム)
Cloudflare Worker (worker/) … hacomono公開APIを集約・CORS付与・60秒キャッシュ
      ↓
hacomono 公開API
```

- `worker/worker.js` — 予約状況を集約して `/schedule` で返すWorker（hacomono以外へは中継しない）
- `docs/index.html` — スマホファーストのビューア。Worker障害時は `docs/schedule.json` にフォールバック
- `scripts/fetch_schedule.py` — フォールバック用 `docs/schedule.json` をローカル生成（任意）

CORSの制約（後述）でブラウザからhacomonoを直接fetchできないため、Workerが取得役を担う。
GitHub Actionsによる定期更新方式は廃止（リアルタイム性を優先）。

空きセルのタップで hacomono の予約画面 `https://enjoyindoorgolf.hacomono.jp/reserve/space/{id_hash}` に遷移する。予約・認証・決済はすべて hacomono 側。

## API調査結果（2026-08-24）

### 公開スケジュールAPI

```
GET https://enjoyindoorgolf.hacomono.jp/api/master/studio-lessons/schedule?query={URLエンコードしたJSON}
query = {"page":1,"is_all":true,"studio_id":1,"studio_room_id":1}
```

- **認証・Cookie・CSRFトークン一切不要**（未ログインで取得可能）
- 注意: `User-Agent` ヘッダが無いと `data:{}` の空応答になる
- 1回の呼び出しで **今日から7日分 × 24時間 = 168スロット** が返る
- レスポンス: `data.studio_lessons.items[]` に各1時間枠
  - `date`, `start_at`, `end_at` — 枠の日時（JST）
  - `reservation_count` — 予約数（0〜3。3打席なので `空き = 3 - reservation_count`）
  - `is_reservable` — 受付時間内か（満席でも true になることがあるので空き判定には使わない）
  - `id_hash` — 予約画面URL `/reserve/space/{id_hash}` に使用
- 個別枠: `GET /api/master/studio-lessons/{id_hash}`
- 打席構成: `data.studio_lessons.studio_room_spaces[0]`（`space_num: 3`、打席1=左右打席、打席2/3=右打席）

### 予約済み打席番号API（重要）

```
GET https://enjoyindoorgolf.hacomono.jp/api/reservation/reservations/{studio_lesson_id}/no
→ {"data":{"nos":[1,2]}}
```

- **未ログインで、その枠の予約済み打席番号がそのまま取れる**（数値の lesson id を使う。id_hash では空が返る）
- `/reserve/space/{id_hash}` ページの座席マップはこのデータでSSRされている
- 本ツールでは予約数>0の枠だけこのAPIを叩き、完全な「時間×打席1/2/3」の○×表を生成する

### 打席別ページ（room 4/5/6）

`/reserve/schedule/1/4` `1/5` `1/6` は「1番/2番/3番打席（6/1~予約開始予定）」のタブで、
同APIに `"studio_room_id": 4/5/6` を渡せば打席単位（各定員1）の予約状況が未ログインで取れる。

**注意（2026-08-24時点）**: 実際の予約はすべて従来の「打席予約」（room 1、3席まとめ）に入っており、
room 4〜6 は全枠予約ゼロ。本ツールは room 1 の予約を上記 `/no` API で打席番号に解決し、
room 4〜6 の予約もマージして表示する（どちらの方式で予約されても検知できる）。
予約リンクは実運用中の room 1 のフロー `/reserve/space/{id_hash}` に統一している。

### CORS

- `Access-Control-Allow-Origin` は hacomono 自身のオリジンのみ許可（`*` ではない）
- **GitHub Pages からの直接 fetch は不可** → GitHub Actions で schedule.json を生成する方式を採用

## セットアップ

### Cloudflare Worker

```
cd worker
npx wrangler login      # 初回のみ (ブラウザでCloudflareにログイン)
npx wrangler deploy     # https://eig-schedule.<subdomain>.workers.dev にデプロイ
```

デプロイ後、`docs/index.html` 冒頭の `WORKER_URL` を実際のURLに書き換える。
ローカル検証は `npx wrangler dev` → `http://localhost:8787/schedule`。
ページ側は `?worker=<URL>` パラメータでWorker URLを一時的に上書きできる。

### GitHub Pages

1. GitHubリポジトリを作成して push
2. Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `docs`

## ローカル確認

```
python3 scripts/fetch_schedule.py
python3 -m http.server -d docs 8000
```
