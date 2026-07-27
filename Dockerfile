FROM node:22-alpine

# Install git, ripgrep, bash for repository tools
RUN apk add --no-cache git ripgrep bash

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8765

CMD ["node", "--env-file=.env", "dist/index.js"]
