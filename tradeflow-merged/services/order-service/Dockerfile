FROM node:20-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY services/order-service/package*.json ./services/order-service/
RUN cd shared && npm install && cd /app/services/order-service && npm install --omit=dev
COPY services/order-service/src ./services/order-service/src
WORKDIR /app/services/order-service
CMD ["node", "src/index.js"]
