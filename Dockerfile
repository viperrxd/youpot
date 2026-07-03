FROM node:20

WORKDIR /app

COPY package.json ./
RUN npm install --ignore-scripts

COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
