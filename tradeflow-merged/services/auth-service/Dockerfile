FROM node:20-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY services/auth-service/package*.json ./services/auth-service/
RUN cd shared && npm install && cd /app/services/auth-service && npm install --omit=dev
COPY services/auth-service/src ./services/auth-service/src
WORKDIR /app/services/auth-service
CMD ["node", "src/index.js"]
