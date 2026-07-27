"""NICO Meet signaling server — 契約①の実装。

ルームごとにWebSocket接続を保持し、offer/answer/iceを`to`宛に転送するだけ。
メディア自体はここを通らない（P2P mesh）。状態はインメモリでMVP十分。
"""
import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

app = FastAPI()

# room -> { user -> websocket }
rooms: Dict[str, Dict[str, WebSocket]] = {}

# `to` 宛に中継してよいメッセージ種別（契約①）。これ以外は捨てる。
RELAYABLE_TYPES = {"offer", "answer", "ice"}

# --- STUN/TURN（NAT越え）設定。環境変数で注入。未設定ならSTUNのみで動く ---
# STUN_URLS はカンマ区切りで複数指定できる（1系統が遮断・レート制限されても他で救う）。
# 後方互換: 旧 STUN_URL 単体も受ける。
_stun_raw = os.environ.get("STUN_URLS") or os.environ.get(
    "STUN_URL", "stun:stun.l.google.com:19302,stun:stun.cloudflare.com:3478"
)
STUN_URLS = [u.strip() for u in _stun_raw.split(",") if u.strip()]

TURN_HOST = os.environ.get("TURN_HOST", "")          # 例: turn.example.com（coturnの公開ホスト）
TURN_TLS_HOST = os.environ.get("TURN_TLS_HOST", "")  # turns:443 用（TLS証明書のあるドメイン）
TURN_SECRET = os.environ.get("TURN_SECRET", "")      # coturnと共有する static-auth-secret
TURN_TTL = int(os.environ.get("TURN_TTL", "3600"))   # 時限クレデンシャルの有効秒数


def _turn_credentials(secret: str, ttl: int, user: str = "") -> tuple[str, str]:
    """coturnの use-auth-secret 方式の時限クレデンシャルを生成。

    username = "<有効期限UNIX秒>[:user]"、credential = base64(HMAC-SHA1(secret, username))。
    これによりクライアントに永続パスワードを渡さずに済む（中継の悪用を防ぐ）。
    """
    expiry = int(time.time()) + ttl
    username = f"{expiry}:{user}" if user else str(expiry)
    digest = hmac.new(secret.encode(), username.encode(), hashlib.sha1).digest()
    credential = base64.b64encode(digest).decode()
    return username, credential


@app.get("/health")
def health():
    """死活監視・切り分け用。Railwayのヘルスチェックからも叩ける。

    メディアはP2Pで流れるためサーバー負荷にはならないが、
    「シグナリングが生きているか」「今何人繋がっているか」はここで分かる。

    ★認証なしで公開される口なので、返すのは**数だけ**に限る。
      部屋名・参加者名を出すと「今この会議に誰がいるか」が公開URLから丸見えになる。
    """
    return {
        "status": "ok",
        "rooms": len(rooms),
        "clients": sum(len(peers) for peers in rooms.values()),
        "stun_count": len(STUN_URLS),
        "turn_configured": bool(TURN_HOST and TURN_SECRET),
    }


@app.get("/ice-config")
def ice_config(user: str = ""):
    """クライアントが接続前に取得するICEサーバー一覧。

    STUNは常に返す（複数系統で単一障害点を避ける）。TURN_HOST/TURN_SECRETが設定されていれば
    時限クレデンシャル付きの TURN も足す。契約②の iceServers に渡す形そのまま。
    """
    ice_servers = [{"urls": STUN_URLS}]
    if TURN_HOST and TURN_SECRET:
        username, credential = _turn_credentials(TURN_SECRET, TURN_TTL, user)
        turn_urls = [
            f"turn:{TURN_HOST}:3478?transport=udp",
            f"turn:{TURN_HOST}:3478?transport=tcp",
        ]
        # UDP全遮断環境の唯一の出口。TLS証明書のあるドメインがある時だけ足す。
        if TURN_TLS_HOST:
            turn_urls.append(f"turns:{TURN_TLS_HOST}:443?transport=tcp")
        ice_servers.append({
            "urls": turn_urls,
            "username": username,
            "credential": credential,
        })
    return {"iceServers": ice_servers}


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    room = websocket.query_params.get("room")
    user = websocket.query_params.get("user")
    if not room or not user:
        await websocket.close(code=4000)
        return

    await websocket.accept()
    peers = rooms.setdefault(room, {})

    # 同名ユーザーの再入室は古い接続を切って上書き（開発中の再読み込み対策）
    old = peers.get(user)
    if old is not None:
        await old.close(code=4001)

    existing = [u for u in peers.keys() if u != user]
    peers[user] = websocket

    await websocket.send_json({"type": "peers", "peers": existing})
    for peer_id in existing:
        await peers[peer_id].send_json({"type": "join", "user": user})

    try:
        while True:
            raw = await websocket.receive_text()

            # 壊れたJSONで接続を落とさない（1通捨てて継続）。
            # json.loads の例外は WebSocketDisconnect では捕まらないため個別に握る。
            try:
                msg = json.loads(raw)
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if not isinstance(msg, dict):
                continue

            # 中継するのは契約①のシグナリング用途に限定する。
            # 任意のtypeを通すと、このサーバーが第三者への汎用メッセージ中継として悪用され得る。
            if msg.get("type") not in RELAYABLE_TYPES:
                continue

            msg["from"] = user
            to = msg.get("to")
            if isinstance(to, str) and to in peers:
                await peers[to].send_json(msg)
    except WebSocketDisconnect:
        pass
    finally:
        if peers.get(user) is websocket:
            del peers[user]
            for peer_ws in peers.values():
                await peer_ws.send_json({"type": "leave", "user": user})
        if not peers:
            rooms.pop(room, None)


class NoCacheStaticFiles(StaticFiles):
    """開発中に古いJS/HTMLがブラウザキャッシュから出るのを防ぐ。"""

    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-store"
        return response


# web/ を静的配信（http://localhost:8000/test.html など）
web_dir = Path(__file__).resolve().parent.parent / "web"
app.mount("/", NoCacheStaticFiles(directory=str(web_dir), html=True), name="web")
