# 念動戦 オンライン対戦サーバ（socket.io）
# game-core は TS ソース直参照のため tsx で実行する。
FROM node:20-slim

WORKDIR /app

# 依存だけ先に入れてビルドキャッシュを効かせる
COPY package.json ./
COPY game-core/package.json ./game-core/
COPY server/package.json ./server/
# tsx（devDependency）も必要なので devDeps 込みで入れる
RUN npm install --include=dev --no-audit --no-fund

# 実行に必要なソースをコピー
COPY game-core ./game-core
COPY server ./server

# ホスティング側が PORT を注入する（未指定なら 8787）
ENV PORT=8787
EXPOSE 8787

CMD ["npm", "run", "start"]
