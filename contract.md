# 契約①②（NICO Meet 共通契約 — 2人合意なく変更しないこと）

出典: `NICO Meet_開発キット_2人共通_v1.0.md` §2 ／ `0723_仕様書_自前ZOOM_NICO_Meet_MVP_v1.0.md` §3

## 契約①：シグナリング WebSocket プロトコル

- 接続URL: `ws://<host>/ws?room=<roomId>&user=<userId>`
- サーバはルームごとに接続を保持し、`to` 指定をその相手へ転送するだけ（メディアは通さない）。状態はインメモリでよい。

| 向き | メッセージ | 意味 |
|---|---|---|
| C→S（接続クエリ） | `room`,`user` | 入室 |
| S→新規参加者 | `{"type":"peers","peers":["u2","u3"]}` | 既存参加者一覧 |
| S→既存者 | `{"type":"join","user":"u4"}` | 誰か入室 |
| C→S→相手 | `{"type":"offer","from","to","sdp"}` | 接続オファー |
| C→S→相手 | `{"type":"answer","from","to","sdp"}` | 応答 |
| C→S→相手 | `{"type":"ice","from","to","candidate"}` | ICE候補 |
| S→全員 | `{"type":"leave","user":"u2"}` | 退出/切断 |

- オファー発火ルール（グレア回避）: **新規参加者が `peers` の既存者全員へ offer を送る**。既存者は offer を受けたら answer を返す。この一方向を厳守。
- サーバは転送時に `from` を送信者IDで補完。切断検知で `leave` をブロードキャスト。

## 契約②：クライアントAPI `ConnectionManager`（`web/connection.js`）

UI/録画側はWebRTC内部を知らず、このAPIだけを使う。クラス名・メソッド名・イベント名を1文字も変えない。

```js
export class ConnectionManager {
  constructor({ room, user, signalingUrl, iceServers }) {}
  on(event, handler) {}
  async join() {}                 // 入室・接続・mesh確立
  leave() {}
  toggleMic(on) {}               // 自分マイク on/off（track.enabled切替）
  toggleCam(on) {}               // 自分カメラ on/off
  getMixedAudioTrack() {}        // 全参加者(自分+相手全員)の音声を1本にmixしたMediaStreamTrack（録画/議事録用）
}
// emitするイベント:
//   'local-stream' (stream)                   自分のカメラ/マイク
//   'peer-joined'  ({ peerId, stream })        相手の映像音声が来た
//   'peer-left'    ({ peerId })                相手が退出
//   'mode-changed' ({ mode:'mesh'|'sfu' })     接続方式（今は常に'mesh'を1回）
```

- `getMixedAudioTrack()` は Web Audio（各音声を `MediaStreamAudioSourceNode` → `MediaStreamAudioDestinationNode` で合流）で実装。人数増減で繋ぎ直す。

## 分担

- 担当A（昇）: `server/` と `web/{connection,config,test}`
- 担当B（角谷）: `web/{index,app,ui,style,recorder,mock-connection}` と `minutes/`
- 相手のファイルは触らない。契約①②を変える時だけ2人合意。
