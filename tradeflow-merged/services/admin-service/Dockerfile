FROM node:20-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY services/admin-service/package*.json ./services/admin-service/
RUN cd shared && npm install && cd /app/services/admin-service && npm install --omit=dev
COPY services/admin-service/src ./services/admin-service/src
WORKDIR /app/services/admin-service
CMD ["node", "src/index.js"]
