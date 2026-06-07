FROM node:22-slim

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY tsconfig.json ./
COPY src/ ./src/

CMD ["npx", "tsx", "src/index.ts"]
