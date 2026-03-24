FROM node:20-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY services/market-data-service/package*.json ./services/market-data-service/
RUN cd shared && npm install && cd /app/services/market-data-service && npm install --omit=dev
COPY services/market-data-service/src ./services/market-data-service/src
WORKDIR /app/services/market-data-service
CMD ["node", "src/index.js"]
