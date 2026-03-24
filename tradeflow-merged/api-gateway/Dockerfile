FROM node:20-alpine
WORKDIR /app
COPY api-gateway/package*.json ./api-gateway/
RUN cd api-gateway && npm install --omit=dev
COPY api-gateway/src ./api-gateway/src
WORKDIR /app/api-gateway
EXPOSE 3000
CMD ["node", "src/index.js"]
