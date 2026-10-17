FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev && npm cache clean --force

USER node
EXPOSE 3000
CMD ["node", "packages/web/src/main.ts"]
