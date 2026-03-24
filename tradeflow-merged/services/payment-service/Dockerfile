FROM node:20-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY services/payment-service/package*.json ./services/payment-service/
RUN cd shared && npm install && cd /app/services/payment-service && npm install --omit=dev
COPY services/payment-service/src ./services/payment-service/src
WORKDIR /app/services/payment-service
EXPOSE 3007
CMD ["node", "src/index.js"]
