# NICO Meet — サーバー（担当A）

シグナリング（合図の中継）＋ 静的配信 ＋ TURN認証情報の発行。
メディア（映像/音声）はここを通らない（P2P mesh）。

## ローカル起動

```bash
cd server
pip install -r requirements.txt
uvicorn signaling:app --reload --port 8000
# http://localhost:8000/test.html?room=r1&user=u1 を2タブで開く
```

カメラ/マイクが無い環境では `&fakemedia=1` を付けると擬似映像・音声で接続を確認できる。

## エンドポイント

| パス | 種別 | 役割 |
|---|---|---|
| `/ws?room=&user=` | WebSocket | シグナリング中継（契約①） |
| `/ice-config?user=` | GET | クライアントに渡すICEサーバー一覧（STUN＋時限TURN） |
| `/health` | GET | 死活監視。`{"status","rooms","clients","turn_configured"}` |
| `/` 以下 | 静的 | `web/` を配信 |

`/health` はRailwayのヘルスチェック（`railway.toml` の `healthcheckPath`）にも使用。
`turn_configured` が `false` ならTURN未設定＝STUNのみで動作中。

> ⚠️ `/health` は認証なしで公開される口です。**返すのは数だけ**にしてください。
> 部屋名・参加者名を出すと「今この会議に誰がいるか」が公開URLから丸見えになります。

## シグナリングの防御（2026-07-24 追加）

| 対策 | 内容 |
|---|---|
| 不正JSONの握り潰し | 壊れたJSON・非dictは**その1通を捨てて継続**。以前は接続ごと切れていた |
| 中継typeのホワイトリスト | `offer` / `answer` / `ice` のみ転送。それ以外は破棄 |
| 静的配信 `no-store` | 開発中に古いJS/HTMLがキャッシュから出るのを防ぐ |

ホワイトリストは**偽装`leave`による強制退出**を防ぐ意味もあります。
以前は任意のtypeを中継していたため、他人へ偽の `leave` を送って会議から追い出すことが可能でした。

## 環境変数

| 変数 | 既定 | 説明 |
|---|---|---|
| `PORT` | 8000 | 待ち受けポート（Railwayは自動注入） |
| `STUN_URL` | `stun:stun.l.google.com:19302` | STUNサーバー |
| `TURN_HOST` | （空） | coturnの公開ホスト。未設定ならSTUNのみ |
| `TURN_SECRET` | （空） | coturnの `static-auth-secret` と同じ値 |
| `TURN_TTL` | 3600 | 時限クレデンシャルの有効秒数 |

TURNは静的パスワードをクライアントに埋め込まず、`/ice-config` が共有シークレットから
**時限クレデンシャル**（coturnの use-auth-secret 方式）を都度発行する。中継の悪用を防ぐため。

## デプロイ（Railway・signaling）

`railway up` は使わない。**main へ push すると自動デプロイ**される運用。

1. Railwayで新規プロジェクト → このリポジトリを接続。
2. Root Directory は既定（`/`）のまま。`railway.toml`（リポジトリ直下）を自動検出し、
   `server/Dockerfile` でビルドする。
   - ※ Dockerfileは `server/` と `web/` の両方を必要とするため、ビルドコンテキストは
     リポジトリ全体。だから `railway.toml` は開発キットの図と違い**リポジトリ直下**に置いている。
3. 環境変数（TURNを使う場合）: `TURN_HOST` `TURN_SECRET` を設定。
4. main へ push → 公開URL（`https://xxx.up.railway.app`）が発行される。
   `test.html` は同一オリジンから `wss://` と `/ice-config` を組み立てるので設定変更不要。

## TURN（coturn）を自前で立てる（MVP+）

TURNはリレー用UDPポート範囲と公開IPが要るため、**Railwayではなく公開IPを持つLinux VPS**で動かす。

1. VPSに Docker を入れる。
2. `server/turn/turnserver.conf` の `YOUR_REALM` / `YOUR_SECRET` / `YOUR_PUBLIC_IP` を書き換える。
   - `YOUR_SECRET` は Railway 側の `TURN_SECRET` と**完全一致**させる。
3. ファイアウォールを開放: `3478/udp`, `3478/tcp`, `49160-49200/udp`（TLS利用時は `5349/tcp` も）。
4. 起動:
   ```bash
   cd server/turn
   docker compose up -d
   ```
5. Railwayの `TURN_HOST` にVPSのホスト名/IPを設定。

### 疎通テスト
- ブラウザで https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ を開き、
  `turn:YOUR_HOST:3478`＋`/ice-config` が返す username/credential を入れて `relay` 候補が出れば成功。
- または本アプリを別ネットワーク（例: スマホのモバイル回線 と PCのWi-Fi）で開いて通話できるか確認。

## 完了条件（A-M3）
別ネットワーク同士が公開 `wss://` URLで通話でき、直P2P不可の回線でも TURN 経由で繋がる。
