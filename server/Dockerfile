# NICO Meet signaling server — Railwayデプロイ用イメージ
FROM python:3.12-slim

WORKDIR /app

# 依存だけ先にコピーしてレイヤーキャッシュを効かせる
COPY server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# サーバーとフロント（静的配信対象）を両方入れる
COPY server/ ./server/
COPY web/ ./web/

WORKDIR /app/server

# RailwayはPORT環境変数を注入する。ローカルは8000。
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn signaling:app --host 0.0.0.0 --port ${PORT}"]
