FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY kishuto.js server.mjs ./
ENV PORT=18081
ENV PUBLIC_BASE=
EXPOSE 18081
CMD ["node", "server.mjs"]
