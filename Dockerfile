FROM node:22-slim

# Install git, ripgrep, curl + .NET + OpenCvSharp native dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates ripgrep \
    libicu-dev libssl3 libgcc-s1 zlib1g \
    libgomp1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install .NET SDK 10.0 (CV-AUT targets .NET 10)
RUN curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/bin/dotnet

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
