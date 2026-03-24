FROM node:20-alpine
WORKDIR /app
COPY shared/ ./shared/
COPY services/portfolio-service/package*.json ./services/portfolio-service/
RUN cd shared && npm install && cd /app/services/portfolio-service && npm install --omit=dev
COPY services/portfolio-service/src ./services/portfolio-service/src
WORKDIR /app/services/portfolio-service
CMD ["node", "src/index.js"]
