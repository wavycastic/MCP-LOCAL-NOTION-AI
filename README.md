# local-repo-mcp

MCP server chay tren may ban, cho Notion AI doc va sua code trong CAC REPO LOCAL.
Mot server phuc vu nhieu repo.

## Phan vai voi gitnexus

Dung ca hai, moi cai mot viec:

| gitnexus | local-repo-mcp (repo nay) |
| --- | --- |
| Hieu code: ai goi ai, sua day thi vo dau | Doc file, sua file, build, test, commit |
| Tra loi tu graph da index | Lam viec tren file that ngay luc nay |
| Chi doc | Co quyen ghi, co deny-list, co branch guard |

Dung gitnexus khi hoi ve symbol. Dung `ripgrep` o day khi tim chuoi van ban thuong
(YAML, .csproj, log, config) — nhung thu khong nam trong graph.

Sau moi `git_commit`, server tu chay lai index cua gitnexus o background. Neu khong
lam vay, graph se cu hon code va agent tra loi sai ma van rat tu tin.

## Cai dat

*Yeu cau Node.js >= 20.6.0 (dung `--env-file=.env`).*

```bash
npm install
cp .env.example .env            # dat MCP_TOKEN dai, ngau nhien
cp repos.example.json repos.json
npm run build && npm start      # hoac: npm run dev
curl localhost:8765/health
bash scripts/tunnel.sh          # lay URL https de dan vao Notion
```

Trong Notion: them MCP server, URL `https://<tunnel>/mcp`, header
`Authorization: Bearer <MCP_TOKEN>`.

### Docker Desktop

```bash
docker compose up -d --build
```

Can `repos.docker.json` dung duong dan TRONG container (`/projects/...`, khong phai
`E:/Projects/...`) va `HOST=0.0.0.0`. Docker image dung `node:22-slim`, co san
Git, ripgrep va .NET SDK 10 de build/test cac repo .NET nhu CV-AUT.

## Khai bao repo

`repos.json` — repo khai bao o day moi duoc ghi:

```json
{
  "defaults": { "branchPrefix": "agent/", "reindex": ["npx", "gitnexus", "analyze"] },
  "repos": [
    { "name": "cv-aut", "path": "C:/code/CV-AUT", "write": true },
    { "name": "tool-x", "path": "C:/code/tool-x", "write": true, "branchPrefix": "*" }
  ]
}
```

`branchPrefix` gioi han branch nao duoc ghi. Dat `"*"` (hoac chuoi rong) de cho ghi
tren MOI branch, ke ca `main`/`master`. Dat cho tung repo, hoac cho tat ca trong
`defaults`.

Dat `WORKSPACE_ROOT` thi moi subdir co `.git` cung duoc tu dong tim thay — nhung
CHI DOC (tru khi bat `AUTO_DISCOVERED_WRITE`).

Build/test/reindex khong khai bao thi tu doan theo toolchain (dotnet, npm, cargo,
go, python, maven).

### Che do Full Access

`ALLOW_FULL_ACCESS=true` (mac dinh hien tai) them repo ao `system`. Repo nay cho phep
cac tool file nhan duong dan tuyet doi (`C:\...`, `E:\...`) va cho `terminal` chay
o bat ky thu muc nao tren may. Day la che do toan quyen, khong bi gioi han boi
`repos.json`, chroot theo repo hay deny-list duong dan.

Dat `ALLOW_FULL_ACCESS=false` neu muon server chi thay repo khai bao trong
`repos.json`/`WORKSPACE_ROOT` va ap dung day du rao chan theo repo.

## 26 tool

| Tool | Viec |
| --- | --- |
| `list_repos` | Liet ke repo, quyen ghi, toolchain |
| `read_file` | Doc file theo dong. Chan binary va file > `MAX_READ_BYTES` |
| `list_dir` | Liet ke thu muc. Bo qua `.git`, `node_modules`, `bin`, `obj`… va thu bi `.gitignore` loai |
| `ripgrep` | Tim chuoi/regex. `all_repos: true` de tim xuyen repo |
| `create_file` | Chi tao file moi, khong ghi de |
| `edit_file` | Thay doan text (`old_str` khop chinh xac; CRLF/LF tu khop) |
| `move_file` | `git mv`, giu blame |
| `remove_file` | `git rm`, chi file da track |
| `git_restore` | Duong lui: tra TUNG file ve HEAD. Khong nhan `.` hay wildcard |
| `run_build` / `run_tests` | Chay lenh build/test cua repo. Cho toi `SYNC_WAIT_MS` roi tu lui ve background |
| `run_lint` / `run_typecheck` | Chay linter/typechecker cua repo (`fix=true` de auto-fix neu toolchain ho tro) |
| `job_status` / `kill_job` | Theo doi job background hoac huy/dung ngay mot background job dang chay |
| `git_status` / `git_diff` / `git_log` / `git_blame` | Doc trang thai va history |
| `git_branch` / `git_stash` | Liet ke/tao/chuyen branch (`branchPrefix` guard) va quan ly working tree stash |
| `git_commit` | Commit. Mac dinh CHI file cac tool nay da sua |
| `git_push` | Mac dinh bi tat (`ALLOW_PUSH`) |
| `gh_pr` | Quan ly GitHub Pull Request qua GitHub CLI (`gh pr status`, `create`, `list`, `view`) |
| `terminal` | Chay lenh shell tuy y (`ALLOW_TERMINAL`, mac dinh hien tai `true`) |
| `reindex` | Chay lai index code graph thu cong |

## Rao an toan

- **Token**: moi request tru `/health` phai co bearer token dung (so sanh timing-safe).
- **Che do gioi han repo** (`ALLOW_FULL_ACCESS=false`): path phai nam trong repo,
  khong thoat root qua `..`/symlink va khong doc cheo repo.
- **Deny-list ca 2 chieu trong che do gioi han repo**: `.env*`, `.git/config`,
  `.git/credentials`, `*.pem|key|pfx`, `secrets/`, `id_rsa*`, `.npmrc` — khong
  doc duoc va cung khong commit duoc.
- **Full Access** (`ALLOW_FULL_ACCESS=true`): chu dong bo qua chroot va deny-list
  duong dan cho repo `system`. Chi bat khi chap nhan cho agent truy cap toan may.
- **Terminal**: `ALLOW_TERMINAL=true` cho phep chay lenh shell tuy y; lenh co the
  doc secret, truy cap mang, sua hoac xoa du lieu. Tat bien nay neu khong can.
- **Branch guard**: repo thong thuong chi ghi khi branch khop `branchPrefix`
  (mac dinh `agent/`). Dat `"*"` neu muon cho ghi ca tren `main`.
- **Repo thong thuong chi duoc ghi khi co `write: true`** trong `repos.json`;
  quy tac nay khong gioi han repo `system` cua Full Access.
- **`git_commit` chi stage file agent da sua** — khong keo theo viec ban dang lam do.
  Muon gom het thi phai noi ro `all: true`.
- **Mutex theo repo**: cac tool co side effect tren cung repo chay tuan tu. Cho qua
  `LOCK_WAIT_MS` (120s) thi bao loi ro thay vi treo im lang.
- **Tat server thi giet luon job dang chay**, khong de lai tien trinh build mo coi.
- **`audit.log`**: ghi moi tool call, da xoa noi dung file va cac truong dai. Tu rotate o 5MB.

## Env

| Bien | Mac dinh |
| --- | --- |
| `MCP_TOKEN` | bat buoc |
| `PORT` | `8765` |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) |
| `REPOS_CONFIG` | `repos.json` |
| `WORKSPACE_ROOT` | khong |
| `AUTO_DISCOVERED_WRITE` | `false` |
| `ALLOW_FULL_ACCESS` | `true` (them repo toan quyen `system`) |
| `DEFAULT_BRANCH_PREFIX` | `agent/` (dat `*` cho moi branch) |
| `ALLOW_PUSH` | `false` |
| `GIT_REMOTE` | `origin` |
| `ALLOW_TERMINAL` | `true` |
| `MAX_READ_BYTES` | `2000000` |
| `MAX_WRITE_BYTES` | `1000000` |
| `LOCK_WAIT_MS` | `120000` |
| `SYNC_WAIT_MS` | `60000` |
| `EXEC_TIMEOUT_MS` | `900000` |
| `DEFAULT_REINDEX_CMD` | `npx gitnexus analyze` |

`DEFAULT_BRANCH_PREFIX` chi ap dung khi `repos.json` khong khai bao `branchPrefix`
(o tung repo hoac trong `defaults`) — file cau hinh thang hon env.

## Phat trien

```bash
npm run typecheck   # tsc --noEmit
npm run smoke       # tao 2 repo git tam, chay het cac tool
```

`npm run smoke` khong can repo that va khong cham repo cua ban. CI chay ca hai.

## Viec con lai

- Chua co test cho tang HTTP (bearer auth, `/mcp`) va cho `git_push` that.
- Smoke chua co case: file CRLF, `new_str` chua `$&`, commit khi khong co gi thay doi.
- `exec.ts` khong giu `SSH_AUTH_SOCK` → push qua SSH se fail; dung HTTPS + credential helper.
- `scripts/tunnel.sh` dung named tunnel khi co `config.yml`; neu khong co thi lui ve Quick Tunnel va URL se doi sau moi lan restart. Nen dung named tunnel + Cloudflare Access cho moi truong on dinh.
