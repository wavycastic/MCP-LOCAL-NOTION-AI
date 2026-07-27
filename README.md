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

*Yêu cầu Node.js >= 20.6.0 (sử dụng tính năng `--env-file=.env` mặc định).*

```bash
npm install
git add package-lock.json && git commit -m "chore: lockfile"   # lam 1 lan
cp .env.example .env            # dat MCP_TOKEN dai, ngau nhien
cp repos.example.json repos.json
npm run build && npm start      # hoac: npm run dev
curl localhost:8765/health
bash scripts/tunnel.sh           # lay URL https de dan vao Notion
```

Trong Notion: them MCP server, URL `https://<tunnel>/mcp`, header
`Authorization: Bearer <MCP_TOKEN>`.

## Khai bao repo

`repos.json` — repo khai bao o day moi duoc ghi:

```json
{
  "defaults": { "branchPrefix": "agent/", "reindex": ["npx", "gitnexus", "analyze"] },
  "repos": [
    { "name": "cv-aut", "path": "C:/code/CV-AUT", "write": true },
    { "name": "tool-x", "path": "C:/code/tool-x" }
  ]
}
```

Dat `WORKSPACE_ROOT` thi moi subdir co `.git` cung duoc tu dong tim thay — nhung
CHI DOC (tru khi bat `AUTO_DISCOVERED_WRITE`).

Build/test/reindex khong khai bao thi tu doan theo toolchain (dotnet, npm, cargo,
go, python, maven).

## 19 tool

| Tool | Viec |
| --- | --- |
| `list_repos` | Liet ke repo, quyen ghi, toolchain |
| `read_file` | Doc file theo dong. Chan binary va file > `MAX_READ_BYTES` |
| `list_dir` | Liet ke thu muc (bo qua `.git`, `node_modules`, `bin`, `obj`…) |
| `ripgrep` | Tim chuoi/regex. `all_repos: true` de tim xuyen repo |
| `create_file` | Chi tao file moi, khong ghi de |
| `edit_file` | Thay doan text (`old_str` phai khop chinh xac) |
| `move_file` | `git mv`, giu blame |
| `remove_file` | `git rm`, chi file da track |
| `git_restore` | Duong lui: tra TUNG file ve HEAD. Khong nhan `.` hay wildcard |
| `run_build` / `run_tests` | Chay lenh cua repo. `background: true` cho viec dai |
| `job_status` | Theo doi job background |
| `git_status` / `git_diff` / `git_log` / `git_blame` | Doc trang thai va history |
| `git_commit` | Commit. Mac dinh CHI file cac tool nay da sua |
| `git_push` | Mac dinh bi tat (`ALLOW_PUSH`) |
| `reindex` | Chay lai index code graph thu cong |

## Rao an toan

- **Token**: moi request tru `/health` phai co bearer token dung (so sanh timing-safe).
- **Chroot theo repo**: path phai tuong doi, khong ra ngoai repo root, khong cheo repo.
- **Deny-list ca 2 chieu**: `.env*`, `.git/config`, `.git/credentials`, `*.pem|key|pfx`,
  `secrets/`, `id_rsa*`, `.npmrc` — khong doc duoc, va cung khong commit duoc.
- **Branch guard**: chi ghi khi dang o branch `agent/*`. Khong bao gio ghi tren `main`.
- **Chi ghi repo duoc cap quyen** trong `repos.json`.
- **`git_commit` chi stage file agent da sua** — khong keo theo viec ban dang lam do.
  Muon gom het thi phai noi ro `all: true`.
- **Mutex theo repo**: cac tool co side effect tren cung repo chay tuan tu. Cho qua
  `LOCK_WAIT_MS` (120s) thi bao loi ro thay vi treo im lang.
- **`audit.log`**: ghi moi tool call, da xoa noi dung file va cac truong dai. Tu rotate o 5MB.

## Env

| Bien | Mac dinh |
| --- | --- |
| `MCP_TOKEN` | bat buoc |
| `PORT` | `8765` |
| `REPOS_CONFIG` | `repos.json` |
| `WORKSPACE_ROOT` | khong |
| `AUTO_DISCOVERED_WRITE` | `false` |
| `DEFAULT_BRANCH_PREFIX` | `agent/` |
| `ALLOW_PUSH` | `false` |
| `MAX_READ_BYTES` | `2000000` |
| `MAX_WRITE_BYTES` | `1000000` |
| `LOCK_WAIT_MS` | `120000` |
| `EXEC_TIMEOUT_MS` | `900000` |
| `DEFAULT_REINDEX_CMD` | `npx gitnexus analyze` |

## Phat trien

```bash
npm run typecheck   # tsc --noEmit
npm run smoke       # tao 2 repo git tam, chay het cac tool, 54 assertion
```

`npm run smoke` khong can repo that va khong cham repo cua ban. CI chay ca hai.

## Viec con lai

- Chua chay lan nao tren may that — con thieu `package-lock.json`.
- Chua co test cho tang HTTP (bearer auth, `/mcp`) va cho `git_push` that.
- `exec.ts` khong giu `SSH_AUTH_SOCK` → push qua SSH se fail; dung HTTPS + credential helper.
- Chua chan header `Host`/`Origin` (DNS rebinding).
- `list_dir`/`ripgrep` chua ton trong `.gitignore`.
- Quick tunnel doi URL moi lan restart → nen chuyen sang named tunnel + Cloudflare Access.
