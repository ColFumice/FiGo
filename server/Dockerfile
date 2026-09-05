FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --production
COPY relay-server.js ./
EXPOSE 8080
CMD ["node", "relay-server.js"]
