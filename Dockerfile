FROM node:22-alpine

# Install git, ripgrep, bash for repository tools
RUN apk add --no-cache git ripgrep bash

# Repo duoc bind-mount tu Windows nen uid chu so huu khac uid trong container.
# Khong co dong nay thi MOI lenh git trong container bao
# "detected dubious ownership in repository" va tat ca tool git deu chet —
# git_status, git_diff, git_commit, ke ca phan doc .gitignore cua list_dir.
RUN git config --global --add safe.directory '*'

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 8765

CMD ["node", "--env-file=.env", "dist/index.js"]
