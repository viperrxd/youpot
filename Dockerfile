FROM node:20-slim

WORKDIR /app

COPY package.json ./

RUN npm install --production

COPY . .

EXPOSE 8080

CMD ["node", "--max-old-space-size=512", "server.js"]
