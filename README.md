# local-repo-mcp

MCP server chay tren may ban, cho Notion AI doc va sua code trong CAC REPO LOCAL.
Mot server phuc vu nhieu repo.

## Phan vai voi gitnexus

Dung ca hai, moi cai mot viec:

| gitnexus | local-repo-mcp (repo nay) |
| --- | --- |
| Hieu code: ai goi ai, sua day thi vo dau | Doc file, sua file, build, test, commit, batch discovery |
| Tra loi tu graph da index | Lam viec tren file that ngay luc nay |
| Chi doc | Co quyen ghi, atomic writes, stale guard, deny-list, branch guard |

Dung gitnexus khi hoi ve symbol. Dung `ripgrep` hoac `glob_files` o day khi tim chuoi van ban/files (YAML, .csproj, log, config) — nhung thu khong nam trong graph.

Sau moi `git_commit`, server tu chay lai index cua gitnexus o background. Neu khong lam vay, graph se cu hon code va agent tra loi sai ma van rat tu tin.

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

`ALLOW_FULL_ACCESS=true` them repo ao `system`. Repo nay cho phep
cac tool file nhan duong dan tuyet doi (`C:\...`, `E:\...`) va cho `terminal` chay
o bat ky thu muc nao tren may. Day la che do toan quyen, khong bi gioi han boi
`repos.json`, chroot theo repo hay deny-list duong dan.

Mac dinh `ALLOW_FULL_ACCESS=false` (fail-closed) de bao ve an toan, server chi thay repo khai bao trong
`repos.json`/`WORKSPACE_ROOT` va ap dung day du rao chan theo repo. Dat `ALLOW_FULL_ACCESS=true` neu muon mo toan quyen.

## Release 4: Agent UX

`repo_overview` va `inspect_codebase` dung cung `repo` name voi execution tools, mac dinh `output_mode: summary`, va ho tro `minimal | summary | full`. Budget `small | medium | large | custom` gioi han token, file, symbol, graph depth va output bytes. Dat `TOOL_PROFILE=agent` de dung registry gon, uu tien cac composite intelligence/edit/verify tools thay vi toan bo primitive.

## 53 tool

| Tool | Viec |
| --- | --- |
| `list_repos` | Liet ke repo, quyen ghi, toolchain |
| `read_file` | Doc file theo dong. Strict UTF-8, BOM/EOL detection, anti-binary |
| `read_many_files` | Doc batch 1-50 file bang bounded parallel I/O trong 1 MCP call |
| `list_dir` | Liet ke thu muc. Bo qua `.git`, `node_modules`, `bin`, `obj`… |
| `glob_files` | Tim file theo glob; regex/result cache 250ms, tu invalidate sau write; ripgrep/git fallback |
| `ripgrep` | Tim chuoi/regex. `all_repos: true` de tim xuyen repo |
| `repo_overview` | Facade FlowLens tra ban do repo va freshness cua persistent index |
| `inspect_codebase` | Hybrid retrieval: FTS5/BM25, local embeddings, symbol/route, graph expansion, rerank, context pack |
| `read_context` | Doc range co merge overlap, line numbers, byte/file budget va content hash |
| `index_files` | Khoi tao hoac cap nhat changed-file incremental index cua FlowLens |
| `find_symbol` | Tim workspace/document symbol TS/JS bang language service |
| `find_references` | Tra definition/reference range chinh xac va write-access metadata |
| `explain_symbol` | Hover/type, diagnostics, rename preview, code actions va graph evidence |
| `trace_flow` | Trace directed execution path hoac bounded downstream flow |
| `what_breaks` | Blast radius upstream/downstream va related tests tu FlowLens graph |
| `search_code` | Tim kiem multi-channel (FTS, graph, semantic) trong codebase qua FlowLens |
| `prepare_change` | Lap ke hoach thay doi: entry point, impact graph, required reads, test scope |
| `can_edit` | Kiem tra an toan chinh sua file/symbol: risk level, contracts, prerequisites |
| `verify_change` | Xac nhan thay doi sau edit: diff vs plan, contract risks, verification checks |
| `create_file` | Chi tao file moi, khong ghi de |
| `edit_file` | Fast matcher (exact -> EOL norm -> trailing WS norm), dung sau match thu 2 khi chi can ambiguity check |
| `multi_edit_file` | Thay nhieu vi tri nguyen tu; fast branch guard doc truc tiep `.git/HEAD` |
| `apply_patch` | Patch nhieu file, parallel temp writes, rollback; `response_detail=summary|diff|full` |
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
| `terminal` | Chay lenh shell (env sanitized, non-login shell, openWorld annotated, job lease lock) |
| `terminal_start` | Mo interactive PTY/ConPTY session; bo `command` de mo shell lau dai |
| `terminal_write` / `terminal_read` | Gui raw input va doc output tang dan bang byte cursor, khong lap output cu |
| `terminal_wait_for` | Cho chuoi/regex xuat hien trong PTY output (long-poll trong 1 call) |
| `terminal_resize` / `terminal_close` / `terminal_list` | Resize, dong va liet ke PTY sessions |
| `reindex` | Chay lai index code graph thu cong |
| `health_check` | Kiem tra process con song: uptime, PID, Node version |
| `readiness_check` | Kiem tra readiness: config, repo registry, git, FlowLens sidecar status |
| `get_metrics` | Lay metrics: tool call counts, durations, FlowLens sidecar status, PTY sessions |

## Rao an toan & Terminal Hardening

- **Token**: moi request tru `/health` phai co bearer token dung (so sanh timing-safe).
- **Text I/O & Atomic Writes**: Moi doc/ghi qua strict UTF-8 decoding (`fatal: true`), validate byte NUL, va ghi qua atomic temp files với EOL/BOM/mode preservation. Anti-oracle hash checks (`expected_sha256`).
- **Terminal Execution Hardening**:
  - `TERMINAL_MODE` (`disabled` | `repo` | `full`).
  - Sanitize environment variables: tu dong loai bo cac secret key (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `CREDENTIAL`) va `MCP_TOKEN` khoi child process.
  - Non-login shell defaults (`sh -c` thay vì `sh -lc`) tranh load secret profile.
  - Mark tool annotations `{ destructive: true, openWorld: true }`.
  - Process-tree termination qua `killTree` (Windows `taskkill /T`).
- **Interactive PTY/ConPTY**:
  - Session ton tai qua nhieu MCP calls; ho tro REPL, debugger va CLI hoi dap.
  - Ring buffer gioi han, byte cursor, incremental read, resize va raw control input (`\\r`, `\\x03`).
  - Gioi han session, idle timeout, lifetime timeout; dong tat ca PTY khi server shutdown.
  - PTY ke thua quyen cua process server. Neu server chay elevated thi PTY cung chay elevated.
- **Repo Lease Locks**: Jobs background giu repo lock lease cho toi khi hoan tat; cancelJob giai phong lease an toan.
- **`audit.log`**: redact noi dung file, patch text, command strings, va `env` object keys.

## Benchmark Metrics

Chay suite benchmark qua:
```bash
npx tsx scripts/benchmark-tools.ts
```

| Benchmark Case | Median (ms) | P95 (ms) | Round Trips | Success Rate |
| :--- | :---: | :---: | :---: | :---: |
| Single edit (`edit_file`) | ~2.3ms | ~3.2ms | 1 | 100% |
| 10 edits (10 × `edit_file`) | ~18.8ms | ~21.6ms | 10 | 100% |
| 10 edits (1 × `multi_edit_file`) | ~2.3ms | ~2.5ms | 1 | 100% |
| 10 file patch (1 × `apply_patch`, summary) | ~22.3ms | ~25.7ms | 1 | 100% |
| Read 10 files (1 × `read_many_files`) | ~6.2ms | ~7.5ms | 1 | 100% |
| Glob files warm cache | ~0.08ms | ~0.1ms | 1 | 100% |

## Env

| Bien | Mac dinh |
| --- | --- |
| `MCP_TOKEN` | bat buoc |
| `PORT` | `8765` |
| `HOST` | `127.0.0.1` (Docker: `0.0.0.0`) |
| `REPOS_CONFIG` | `repos.json` |
| `WORKSPACE_ROOT` | khong |
| `AUTO_DISCOVERED_WRITE` | `false` |
| `ALLOW_FULL_ACCESS` | `false` (fail-closed, dat `true` de mo repo `system`) |
| `DEFAULT_BRANCH_PREFIX` | `agent/` (dat `*` cho moi branch) |
| `ALLOW_PUSH` | `false` |
| `GIT_REMOTE` | `origin` |
| `ALLOW_TERMINAL` | `false` (kill switch terminal) |
| `TERMINAL_MODE` | `full` |
| `TERMINAL_MAX_COMMAND_CHARS` | `20000` |
| `TERMINAL_INHERIT_SECRETS` | `false` |
| `PTY_MAX_SESSIONS` | `8` |
| `PTY_BUFFER_BYTES` | `1000000` |
| `PTY_READ_MAX_BYTES` | `100000` |
| `PTY_MAX_INPUT_CHARS` | `100000` |
| `PTY_IDLE_TIMEOUT_MS` | `1800000` (30 phut) |
| `PTY_MAX_LIFETIME_MS` | `14400000` (4 gio) |
| `MAX_READ_BYTES` | `2000000` |
| `MAX_WRITE_BYTES` | `1000000` |
| `LOCK_WAIT_MS` | `120000` |
| `SYNC_WAIT_MS` | `60000` |
| `EXEC_TIMEOUT_MS` | `900000` |
| `TOOL_PROFILE` | `full` (`full`, `agent`, `core`, `safe`) |
| `DEFAULT_REINDEX_CMD` | `npx gitnexus analyze` |
| `FLOWLENS_AUTO_INDEX` | `true`; tu cap nhat changed files sau write thanh cong |
| `FLOWLENS_CLI` | tuy chon duong dan `dist/cli/index.js`; mac dinh tim repo FlowLens ke ben |

## Phat trien

```bash
npm run typecheck   # tsc --noEmit
npm run smoke       # tao repo git tam, chay test suite
npx tsx scripts/benchmark-tools.ts
```
