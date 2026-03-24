FROM node:20-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY services/notification-service/package*.json ./services/notification-service/
RUN cd shared && npm install && cd /app/services/notification-service && npm install --omit=dev
COPY services/notification-service/src ./services/notification-service/src
WORKDIR /app/services/notification-service
CMD ["node", "src/index.js"]
