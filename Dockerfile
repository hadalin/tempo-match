FROM node:24-alpine

ENV NODE_ENV=production
ENV DATA_DIR=/data
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci --omit=dev && npm cache clean --force
RUN mkdir /data && chown node:node /data

USER node
EXPOSE 3000
CMD ["node", "packages/matcher/src/main.ts"]
