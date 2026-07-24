# NICO Meet（自前ZOOM）

相手にインストールさせず、**ブラウザだけで動くビデオ会議**を自前で作る。
少人数は完全P2P（mesh）でメディアがサーバーを通らないため、サーバー費はほぼ0。

## まず読むもの

| ファイル | 誰が読む | 内容 |
|---|---|---|
| **[結合手順.md](結合手順.md)** | **担当B（角谷さん）** | 使えるAPI・実装例・切り分け表。**まずこれ** |
| [contract.md](contract.md) | 2人 | 契約①②（変更は2人合意） |
| [server/README.md](server/README.md) | 担当A（昇） | サーバー・TURN・デプロイ手順 |

## 起動

```bash
cd server
pip install -r requirements.txt
uvicorn signaling:app --reload --port 8000
```

- 契約適合検査（動く実装例）: http://localhost:8000/test-contract.html?room=c1&user=alice
- 接続確認（2タブで開く）: http://localhost:8000/test.html?room=r1&user=u1&fakemedia=1

`&fakemedia=1` はカメラ無しでも動く疑似映像モード。

## 分担

| 担当 | 領域 | ファイル |
|---|---|---|
| **A（昇）** | 通信：WebRTC・シグナリング・NAT越え・デプロイ | `server/`, `web/{connection,config,test,test-contract}` |
| **B（角谷）** | 体験：UI・録画・議事録 | `web/{index,app,ui,style,recorder}`, `minutes/` |

**相手のファイルは触らない。** 契約①②を変えたい時だけ2人で合意する。

## 進捗

- **担当A: A-M1〜A-M3 完了**（2者/4者mesh・音声mix・TURN設定・Railwayデプロイ構成）
  - 契約②適合検査 全16項目PASS（`web/test-contract.html`）
  - 未完了: 実デプロイ（Railway/coturn用VPSが必要）、A-M4（SFU・将来）
- **担当B: 未着手** → `結合手順.md` の「最初の一手」から

### ロードマップ（見える成果の節目）
- **S4**: 2人が顔を見て話せる ← A側完成・BのUI待ち
- **S8**: 録画→議事録が自動で出る（**MVP完成**）
- **S9**: 公開URLで社外の人も参加できる

## 構成

```
server/          シグナリング（FastAPI+WebSocket）／TURN設定／デプロイ
  signaling.py     WS中継＋静的配信＋/ice-config（時限TURNクレデンシャル）
  turn/            coturn設定（VPS前提）
web/
  connection.js    ConnectionManager（契約②の本物実装・担当A）
  config.js        getIceServers（STUN/TURN取得・担当A）
  test.html        接続確認ページ（担当A）
  test-contract.html 契約②適合検査（担当A）
minutes/         録画→議事録（担当B）
```
