# local-repo-mcp

Server MCP (Model Context Protocol) chạy trên máy cá nhân (local), hỗ trợ kết nối các trợ lý AI (Notion AI, Claude, Antigravity CLI, ...) với các repository mã nguồn cục bộ trên máy tính của bạn. Server cung cấp các công cụ đọc mã nguồn, chỉnh sửa tệp tin ngầm và nguyên tử, thực thi lệnh build/test, commit Git và mở phiên Terminal/PTY tương tác.

> [!IMPORTANT]
> **Tài liệu được đối chiếu trực tiếp với mã nguồn thực tế (phiên bản v0.3.0).**
> Server hiện đăng ký **45 công cụ MCP** chính thức, hỗ trợ kiểm soát đường dẫn theo repository, bảo vệ branch, ghi tệp nguyên tử, xác thực Bearer token an toàn và các phương thức thực thi qua Node.js CLI, Docker hoặc ứng dụng Electron Desktop.

---

## 1. Kiến trúc hệ thống

```mermaid
flowchart TD
    Client["Client (Notion AI / Claude / MCP Client)"]
    Tunnel["Cloudflare Tunnel / Direct HTTP"]
    Express["Express HTTP Server (port 8765)"]
    Auth["Timing-Safe Bearer Auth (/mcp)"]
    MCP["MCP Server Protocol Handler"]
    
    SubGraphLocks["Repo Lock Manager (withLock)"]
    
    SubGraphTools["45 Tools Registry"]
    DiscoveryTools["Phân nhóm: Đọc & khám phá (6)"]
    EditTools["Phân nhóm: Chỉnh sửa & patch (7)"]
    GitTools["Phân nhóm: Thao tác Git (9)"]
    BuildTools["Phân nhóm: Build, test & job (6)"]
    TermTools["Phân nhóm: Terminal & PTY (8)"]
    SubAgentTools["Phân nhóm: Antigravity Sub-agent (5)"]
    SysTools["Phân nhóm: Hệ thống & metrics (4)"]

    Security["Giới hạn đường dẫn & danh sách cấm"]
    GitNexus["GitNexus Indexer Sidecar"]
    LocalRepos["Local Repositories (FileSystem / Git)"]

    Client -->|Bearer Auth| Tunnel
    Tunnel --> Express
    Express --> Auth
    Auth --> MCP
    MCP --> SubGraphLocks
    SubGraphLocks --> SubGraphTools
    
    SubGraphTools --> DiscoveryTools
    SubGraphTools --> EditTools
    SubGraphTools --> GitTools
    SubGraphTools --> BuildTools
    SubGraphTools --> TermTools
    SubGraphTools --> SubAgentTools
    SubGraphTools --> SysTools

    EditTools --> Security
    GitTools --> Security
    TermTools --> Security
    Security --> LocalRepos
    GitTools -->|git_commit (reindex: true)| GitNexus
```

### Các thành phần chính
- **Express HTTP Server**: Tiếp nhận kết nối HTTP Streamable Transport tại endpoint `/mcp` với middleware kiểm tra Bearer token timing-safe.
- **Tool Registry**: Đăng ký và quản lý 45 công cụ MCP, lọc theo 4 profile cấu hình (`full`, `agent`, `core`, `safe`).
- **Path Resolver & Security**: Đảm bảo mọi đường dẫn tệp đều được phân giải (resolve) và xác minh nằm trong thư mục gốc của repository chỉ định, ngăn chặn path traversal (`../`), symlink escape và kiểm tra danh sách cấm (Deny-List).
- **Repo Lock Manager**: Quản lý khóa độc quyền theo từng repository (`withLock`) để tránh xung đột ghi tệp và tranh chấp dữ liệu khi có nhiều yêu cầu đồng thời.
- **PTY Session Manager**: Quản lý các phiên terminal tương tác kéo dài (`node-pty`) có hỗ trợ ring buffer, bộ đếm byte cursor và tự động dọn dẹp khi hết thời gian chờ.
- **Tích hợp GitNexus**: Mặc định kích hoạt lệnh re-index ngầm (`repo.reindex`, mặc định `npx gitnexus analyze`) sau mỗi lần `git_commit` thành công (có thể tắt bằng `reindex: false`).
- **Ứng dụng Electron Desktop**: Cung cấp giao diện đồ họa kèm khay hệ thống (System Tray) để quản lý khởi chạy MCP server, GitNexus proxy và Cloudflare tunnel.

---

## 2. Yêu cầu hệ thống

- **Node.js**: `>= 22.5.0` (yêu cầu tính năng `--env-file` native và ESM modules theo `package.json`).
- **Git**: Đã cài đặt và có trong đường dẫn hệ thống (`PATH`).
- **Hệ điều hành**: Windows 10/11, macOS, hoặc Linux.
- **Công cụ tùy chọn theo dự án**:
  - `ripgrep` (tăng tốc tìm kiếm chuỗi văn bản).
  - `.NET SDK` / `npm` / `cargo` / `python` (tùy thuộc vào toolchain dự án cần build/test).
  - `cloudflared` (nếu cần mở Cloudflare Tunnel kết nối tới Notion AI).

---

## 3. Cài đặt và khởi chạy

### Cách 1: Chạy trực tiếp qua Node.js (CLI)

```bash
# 1. Cài đặt các gói phụ thuộc
npm install

# 2. Tạo file cấu hình môi trường từ mẫu
cp .env.example .env
# Chỉnh sửa MCP_TOKEN trong .env thành chuỗi ngẫu nhiên an toàn

# 3. Tạo file khai báo danh sách repo
cp repos.example.json repos.json

# 4. Kiểm tra kiểu dữ liệu và build
npm run typecheck
npm run build

# 5. Khởi chạy server
npm start
# Hoặc chế độ phát triển: npm run dev
```

Kiểm tra liveness của server:
```bash
curl http://127.0.0.1:8765/health
```

### Cách 2: Chạy qua ứng dụng Electron Desktop

Giao diện đồ họa hỗ trợ quản lý server, sinh token ngẫu nhiên, xem log và điều khiển Cloudflare Tunnel / GitNexus Proxy.

```bash
# Khởi chạy giao diện Desktop
npm run gui

# Đóng gói thành bản Portable trên Windows
npm run dist:win
```

### Cách 3: Chạy bằng Docker Desktop

> [!WARNING]
> **Cảnh báo về cấu hình Docker**: File `docker-compose.yml` trong repository hiện chứa các đường dẫn tuyệt đối local (`E:/Projects:...`, `C:\Users\Administrator\...`), bind mount và `AUTH_TOKEN` mẫu cụ thể theo máy cá nhân. Bạn **bắt buộc phải tùy chỉnh** `docker-compose.yml` và `repos.docker.json` để khớp với đường dẫn và credential thực tế trên máy mình trước khi khởi chạy container.

```bash
# Sau khi đã điều chỉnh docker-compose.yml và repos.docker.json:
docker compose up -d --build
```
*Lưu ý*: Với Docker, đường dẫn repo trong `repos.docker.json` phải là đường dẫn tuyệt đối bên trong container (ví dụ: `/projects/cv-aut`). Docker image sử dụng `node:22-slim`, cài sẵn Git, `ripgrep` và `.NET SDK 10`.

---

## 4. Cấu hình chi tiết

### 4.1. Khai báo danh sách repository (`repos.json`)

Khi `WORKSPACE_ROOT` không được cấu hình trong `.env`, server chỉ phục vụ các repository được khai báo tường minh trong `repos.json`:

```json
{
  "defaults": {
    "branchPrefix": "agent/",
    "reindex": ["npx", "gitnexus", "analyze"]
  },
  "repos": [
    {
      "name": "cv-aut",
      "path": "E:/Projects/CV-AUT",
      "write": true,
      "branchPrefix": "agent/"
    },
    {
      "name": "tool-x",
      "path": "E:/Projects/tool-x",
      "write": true,
      "branchPrefix": "*"
    }
  ]
}
```

#### Thuộc tính của từng repository:
- `name`: Tên định danh repo dùng trong tham số lệnh (duy nhất, không phân biệt hoa thường).
- `path`: Đường dẫn tuyệt đối tới repository local trên máy.
- `write`: `true` để cho phép ghi tệp, commit; `false` (mặc định) là chỉ đọc.
- `branchPrefix`: Prefix của Git branch cho phép ghi (ví dụ: `agent/`). Đặt `"*"` hoặc chuỗi rỗng để cho phép ghi trên mọi branch (kể cả `main`/`master`).
- `build` / `test` / `lint` / `typecheck`: Mảng câu lệnh dạng argv (ví dụ: `["npm", "run", "build"]`). Nếu không khai báo, server tự suy đoán theo toolchain (`npm`, `dotnet`, `cargo`, `go`, `python`, `maven`).
- `reindex`: Mảng câu lệnh re-index chạy ngầm sau commit (mặc định: `["npx", "gitnexus", "analyze"]`).

### 4.2. Tự động phát hiện repository (`WORKSPACE_ROOT`)

Nếu cấu hình `WORKSPACE_ROOT` trong `.env`, tất cả thư mục con trực tiếp chứa thư mục `.git` sẽ tự động được nhận diện.
- Mặc định các repo tự phát hiện là **chỉ đọc (read-only)**.
- Đặt `AUTO_DISCOVERED_WRITE=true` nếu muốn mở quyền ghi cho các repo tự phát hiện.

### 4.3. Chế độ toàn quyền local (`ALLOW_FULL_ACCESS`)

> [!CAUTION]
> **Cảnh báo an toàn quan trọng**: Mặc định `ALLOW_FULL_ACCESS=false` (fail-closed).
> Khi đặt `ALLOW_FULL_ACCESS=true`, server sẽ tạo một repository ảo tên `system` với root `__FULL_ACCESS__`. Theo mã nguồn `src/security/paths.ts` (dòng 49), chế độ này **hoàn toàn bỏ qua cả giới hạn đường dẫn theo repository lẫn danh sách cấm (Deny-List)**. AI có thể truy cập, đọc và chỉnh sửa bất kỳ tệp tin nào trên toàn bộ máy tính qua đường dẫn tuyệt đối (`C:\...`, `E:\...`), bao gồm cả tệp `.env`, khóa SSH, chứng thư bảo mật. Chỉ bật lựa chọn này trên máy cá nhân khi thực sự cần thiết và tuyệt đối không mở tunnel ra internet khi đang bật chế độ này.

---

## 5. Danh sách 45 công cụ MCP (Tool Registry)

Server đăng ký chính xác **45 công cụ MCP** phân làm 7 nhóm chức năng:

### Nhóm 1: Đọc và khám phá mã nguồn (6 công cụ)
| Công cụ | Mô tả |
| :--- | :--- |
| `list_repos` | Liệt kê các repo đang phục vụ, quyền ghi (`write`) và toolchain. Nên gọi đầu tiên khi chưa biết tên repo. |
| `read_file` | Đọc 1 tệp tin theo đường dẫn tương đối (hỗ trợ phân trang theo dòng và kiểm tra UTF-8 strict). |
| `read_many_files` | Đọc từ 1 đến 50 tệp tin cùng lúc trong 1 lệnh gọi để giảm số lượt gửi request. |
| `list_dir` | Liệt kê cây thư mục (tự động bỏ qua `node_modules`, `bin`, `obj`, `dist`, `.git`). |
| `glob_files` | Tìm đường dẫn tệp theo mẫu pattern glob (cache kết quả regex 250ms). |
| `ripgrep` | Tìm kiếm chuỗi/regex trong codebase (hỗ trợ `all_repos: true` để tìm xuyên các repo). |

### Nhóm 2: Chỉnh sửa tệp và áp dụng patch (7 công cụ)
| Công cụ | Mô tả |
| :--- | :--- |
| `edit_file` | Thay thế 1 vị trí văn bản trong 1 tệp (`old_str` -> `new_str`), bảo toàn CRLF/LF và BOM. |
| `multi_edit_file` | Thay thế nhiều vị trí không liên tục trong 1 tệp ngầm nguyên tử (tự động rollback nếu có khối lỗi). |
| `apply_patch` | Áp dụng unified diff patch đa tệp (Add, Update, Move, Delete) có hỗ trợ dry-run và rollback nguyên tử. |
| `create_file` | Tạo tệp mới hoàn toàn (từ chối ghi đè nếu tệp đã tồn tại). |
| `move_file` | Đổi tên hoặc di chuyển tệp bằng `git mv` (giữ lịch sử commit). |
| `remove_file` | Xóa tệp đã track bằng `git rm`. |
| `git_restore` | Phục hồi 1 tệp cụ thể về trạng thái commit `HEAD` ban đầu (từ chối đường dẫn wildcard và thư mục). |

### Nhóm 3: Build, test và quản lý tiến trình ngầm (6 công cụ)
| Công cụ | Mô tả |
| :--- | :--- |
| `run_build` | Chạy lệnh build mặc định của repo (`npm run build`, `dotnet build`, ...). |
| `run_tests` | Chạy bộ unit test mặc định của repo (`npm test`, `dotnet test`, ...). |
| `run_lint` | Chạy linter mặc định (`eslint`, `cargo clippy`, ...). |
| `run_typecheck` | Chạy kiểm tra kiểu dữ liệu (`tsc`, `mypy`, ...). |
| `job_status` | Trả về trạng thái và log kết quả của 1 background job đang/đã thực thi. |
| `kill_job` | Tiêu diệt tiến trình cha và toàn bộ cây tiến trình con của 1 background job. |

### Nhóm 4: Thao tác Git (9 công cụ)
| Công cụ | Mô tả |
| :--- | :--- |
| `git_status` | Xem trạng thái working tree (clean/dirty), staged files và branch hiện tại. |
| `git_branch` | Liệt kê các branch, tạo branch mới (kiểm tra quyền ghi và `branchPrefix`), hoặc chuyển sang branch đã có sẵn (không kiểm tra prefix khi chuyển, nhưng các thao tác ghi sau đó trên branch này sẽ bị `assertWritableBranch` kiểm tra). |
| `git_stash` | Lưu tạm (stash) hoặc khôi phục các thay đổi chưa commit. |
| `git_diff` | Xem thay đổi chi tiết (diff) so với HEAD hoặc staged. |
| `git_log` | Xem lịch sử các commit gần đây. |
| `git_blame` | Xem lịch sử chỉnh sửa theo từng dòng của 1 tệp. |
| `git_commit` | Tạo commit (mặc định chỉ stage các tệp do các công cụ MCP sửa đổi; tự động kích hoạt re-index ngầm trừ khi đặt `reindex: false`). |
| `git_push` | Push branch hiện tại lên remote (yêu cầu `ALLOW_PUSH=true`). |
| `gh_pr` | Quản lý, tạo hoặc xem GitHub Pull Request qua GitHub CLI (`gh`). |

### Nhóm 5: Terminal và PTY tương tác (8 công cụ)
| Công cụ | Mô tả |
| :--- | :--- |
| `terminal` | Chạy 1 lệnh shell đơn lẻ (stateless) trong thư mục repo và trả kết quả ngay. |
| `terminal_start` | Mở phiên PTY/ConPTY tương tác kéo dài (stateful) để chạy các lệnh tương tác. |
| `terminal_write` | Gửi raw input hoặc phím điều khiển (`Ctrl+C`, `Enter`) vào phiên PTY. |
| `terminal_read` | Đọc luồng output mới từ PTY theo byte cursor tăng dần (không lặp lại output cũ). |
| `terminal_wait_for` | Đợi chuỗi/regex xuất hiện trong output PTY (long-poll trong 1 MCP call). |
| `terminal_resize` | Đổi kích thước cửa sổ hiển thị PTY. |
| `terminal_close` | Đóng và kết thúc phiên PTY. |
| `terminal_list` | Liệt kê các phiên PTY đang hoạt động. |

### Nhóm 6: Tích hợp Antigravity Sub-agent (5 công cụ)
| Công cụ | Mô tả |
| :--- | :--- |
| `antigravity_spawn` | Khởi chạy Antigravity sub-agent ngầm qua CLI (`agy`) cho các tác vụ phức tạp. |
| `antigravity_poll` | Đọc tiến độ, sự kiện tool call và kết quả phản hồi của sub-agent. |
| `antigravity_reply` | Gửi tiếp lượt hội thoại vào phiên sub-agent hiện tại. |
| `antigravity_stop` | Dừng tiến trình sub-agent. |
| `antigravity_list` | Liệt kê các phiên sub-agent đang hoạt động. |

### Nhóm 7: Hệ thống và thống kê (4 công cụ)
| Công cụ | Mô tả |
| :--- | :--- |
| `reindex` | Chạy lại lệnh re-index mã nguồn thủ công (`repo.reindex`). |
| `health_check` | Liveness probe: Uptime, PID, phiên bản Node.js. |
| `readiness_check` | Readiness probe: Kiểm tra tính hợp lệ của cấu hình và danh sách repo. |
| `get_metrics` | Lấy thống kê số lượt gọi công cụ, thời gian thực thi và danh sách phiên PTY. |

---

## 6. Phân vùng profile công cụ (`TOOL_PROFILE`)

Biến môi trường `TOOL_PROFILE` trong `src/config.ts` cho phép giới hạn danh sách công cụ mở ra cho AI client:

- **`full`** (Mặc định): Mở toàn bộ **45 công cụ**.
- **`core`**: Mở **28 công cụ cơ bản** (`CORE_ALLOWED` trong `src/tools/index.ts`), ẩn các công cụ chỉnh sửa patch/file nâng cao (`apply_patch`, `move_file`, `remove_file`), `git_push`, `gh_pr`, `kill_job` và các công cụ terminal thực thi lệnh (`terminal`, `terminal_start`, `terminal_write`, `terminal_read`, `terminal_resize`, `terminal_close`, `terminal_list`), nhưng **vẫn mở `terminal_wait_for`**.
- **`agent`**: Mở **9 công cụ tích hợp** (`AGENT_ALLOWED`), tập trung vào `list_repos`, `apply_patch`, `run_typecheck`, `run_tests`, `git_status`, `git_diff` và bộ công cụ sub-agent.
- **`safe`**: Tự động ẩn các công cụ có đánh dấu `destructive: true`, `openWorld: true` hoặc `git_push`.

---

## 7. Quy tắc an toàn và kiểm soát rủi ro

1. **Xác thực token timing-safe**: Mọi request tới `/mcp` đều phải có Header `Authorization: Bearer <MCP_TOKEN>`. Việc so sánh token được thực hiện bằng cách băm SHA-256 trước khi gọi `timingSafeEqual` để loại bỏ tấn công kênh thời gian (Timing Attack).
2. **Giới hạn đường dẫn theo repository (Path confinement)**: Đường dẫn tệp được phân giải (`safeResolve`) và xác minh nằm trong thư mục gốc của repository tương ứng. Hệ thống tự động từ chối đường dẫn tuyệt đối, path traversal (`../`) và symlink trỏ ra ngoài repo.
3. **Danh sách cấm (Deny-List)**: Chặn thao tác đọc/ghi tới `.env` (trừ các file mẫu như `.env.example`), `.git/config`, `.git/hooks/`, SSH keys, private keys (`.pem`, `.key`, `.pfx`), file chứa thông tin nhạy cảm (`secrets/`). *(Lưu ý: Deny-List bị bỏ qua nếu bật `ALLOW_FULL_ACCESS=true`)*.
4. **Bảo vệ Git branch (Branch Guard)**: Thao tác ghi/commit chỉ được phép thực hiện trên các branch có tên bắt đầu bằng `branchPrefix` được cấu hình cho repo (mặc định `agent/`), hoặc trên mọi branch khi `branchPrefix` được cấu hình là `""` hoặc `"*"`.
5. **Ghi tệp nguyên tử và bảo toàn định dạng**: Thực hiện I/O qua UTF-8 strict (`fatal: true`), loại bỏ ký tự NUL, ghi qua file tạm `.tmp` rồi đổi tên nguyên tử (atomic rename). Bảo toàn ký tự dòng kết thúc (CRLF/LF), ký tự BOM và phân quyền tệp.
6. **Xác minh hash chống trạng thái cũ / xung đột ghi đồng thời (Stale-write guard / Optimistic concurrency)**: Hỗ trợ kiểm tra `expected_sha256` hoặc `expected_head_sha` trước khi sửa tệp/patch. Nếu tệp bị sửa đổi song song, lệnh sẽ bị từ chối mà không làm lộ nội dung thực tế.
7. **Làm sạch môi trường Terminal**: Khi `TERMINAL_INHERIT_SECRETS=false` (mặc định), tiến trình con terminal sẽ tự động bị loại bỏ các biến môi trường chứa bí mật (`TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `CREDENTIAL`, `MCP_TOKEN`). Nếu đặt `TERMINAL_INHERIT_SECRETS=true`, các biến bí mật này sẽ được truyền nguyên vẹn cho tiến trình terminal con.

---

## 8. Biến môi trường chi tiết (`.env`)

| Biến môi trường | Giá trị mặc định | Mô tả |
| :--- | :--- | :--- |
| `MCP_TOKEN` | *(Bắt buộc)* | Token Bearer xác thực truy cập endpoint `/mcp`. |
| `PORT` | `8765` | Cổng HTTP server lắng nghe. |
| `HOST` | `127.0.0.1` | Địa chỉ IP bind (trong Docker đặt `0.0.0.0`). |
| `REPOS_CONFIG` | `repos.json` | Đường dẫn tệp cấu hình danh sách repository. |
| `WORKSPACE_ROOT` | *(Không)* | Thư mục cha chứa nhiều repo để tự động nhận diện. |
| `AUTO_DISCOVERED_WRITE` | `false` | Cho phép ghi đối với repo tự động phát hiện. |
| `ALLOW_FULL_ACCESS` | `false` | Bật repo ảo `system` (bỏ qua path confinement & Deny-List). |
| `DEFAULT_BRANCH_PREFIX` | `agent/` | Prefix branch mặc định cho phép ghi (đặt `*` cho mọi branch). |
| `ALLOW_PUSH` | `false` | Bật/tắt công cụ `git_push`. |
| `GIT_REMOTE` | `origin` | Tên Git remote mặc định. |
| `ALLOW_TERMINAL` | `false` | Master kill-switch cho các công cụ terminal. |
| `TERMINAL_MODE` | `disabled` | Chế độ terminal: `disabled` \| `repo` \| `full`. |
| `TERMINAL_INHERIT_SECRETS` | `false` | Kế thừa biến môi trường bí mật vào tiến trình terminal con. |
| `PTY_MAX_SESSIONS` | `8` | Số lượng phiên PTY tối đa được mở đồng thời. |
| `MAX_READ_BYTES` | `2000000` | Giới hạn dung lượng tệp tối đa khi đọc (2MB). |
| `MAX_WRITE_BYTES` | `1000000` | Giới hạn dung lượng nội dung tối đa khi ghi (1MB). |
| `LOCK_WAIT_MS` | `120000` | Thời gian tối đa chờ khóa repo rảnh (120 giây). |
| `TOOL_PROFILE` | `full` | Profile lọc công cụ: `full` \| `agent` \| `core` \| `safe`. |
| `ANTIGRAVITY_ENABLE` | `true` | Bật/tắt khả năng thực thi của bộ công cụ `antigravity_*` (khi đặt `false`, các công cụ vẫn nằm trong danh sách đăng ký nhưng sẽ từ chối và trả lỗi khi được gọi). |

---

## 9. Kiểm thử và đánh giá hiệu năng

### 9.1. Kịch bản kiểm thử tích hợp (`smoke.ts`)

File `scripts/smoke.ts` tạo 2 repository Git tạm thời trong thư mục môi trường biệt lập để thực thi các kiểm thử tích hợp trực tiếp với handler của công cụ (bỏ qua tầng HTTP).

Kịch bản smoke test thực tế tập trung xác minh các luồng làm việc chính:
- Khai báo repo registry và phân quyền read-only / writable.
- Phân trang đọc tệp, đọc nhiều tệp (`read_many_files`), giới hạn dung lượng byte, lọc tệp binary.
- Tìm kiếm tệp qua `glob_files` và `ripgrep` (trong repo và xuyên repo).
- Kiểm tra giới hạn đường dẫn, chống traversal và danh sách cấm (Deny-List).
- Kiểm tra rào chắn ghi branch (`branchPrefix`).
- Chỉnh sửa tệp đơn lẻ (`edit_file`), sửa tệp nguyên tử (`multi_edit_file`), rollback khi lỗi và xác minh hash chống trạng thái cũ/xung đột ghi đồng thời.
- Áp dụng unified diff patch (`apply_patch`) đa tệp, kiểm tra dry-run và các cấp độ rollback tự động khi gặp lỗi mid-commit.
- Thao tác Git (`git_status`, `git_commit`, `git_restore`, `git_branch`, `git_stash`, `remove_file`).
- Thực thi Terminal, kiểm tra tính năng sanitize môi trường và quản lý PTY session.
- Thực thi build/test background job, khóa repo lock đồng thời và kiểm tra dọn dẹp cây tiến trình (`kill_job`).

Kết quả kiểm thử khi chạy với môi trường chuẩn:
```powershell
$env:DEFAULT_BRANCH_PREFIX="agent/"; npm run smoke
```
Trả về kết quả: **`167 pass, 0 fail`** trên tổng số 167 assertion của script `smoke.ts`.

### 9.2. Kết quả đo hiệu năng thực nghiệm (Benchmark)

Các số liệu dưới đây được đo lường thực nghiệm bằng `npx tsx scripts/benchmark-tools.ts` trên môi trường máy thử nghiệm (Windows 11, Node.js v22.22.2, 20 lần lặp/case). Số liệu mang tính chất tham khảo thực tế cho môi trường đó, không phải cam kết hiệu năng cố định trên mọi phần cứng:

| Kịch bản benchmark | Trung vị (Median) | P95 | Số round trips | Tỷ lệ thành công |
| :--- | :---: | :---: | :---: | :---: |
| Single edit (`edit_file`) | **2.18 ms** | 3.95 ms | 1 | 100% |
| 10 edits (10 × `edit_file`) | **16.74 ms** | 17.52 ms | 10 | 100% |
| 10 edits (1 × `multi_edit_file`) | **2.32 ms** | 2.78 ms | 1 | 16680 B |
| 10 files patch (1 × `apply_patch`) | **20.39 ms** | 21.65 ms | 1 | 100% |
| Read 10 files (10 × `read_file`) | **6.40 ms** | 7.24 ms | 10 | 100% |
| Read 10 files (1 × `read_many_files`) | **5.57 ms** | 6.35 ms | 1 | 100% |
| List directory (`list_dir`) | **22.62 ms** | 23.88 ms | 1 | 100% |
| Glob files (Warm Cache) | **0.05 ms** | 13.97 ms | 1 | 100% |
| Terminal Foreground | **8.92 ms** | 10.01 ms | 1 | 100% |

---

## 10. Xử lý sự cố (Troubleshooting)

### Lỗi 1: `401 Unauthorized`
- **Nguyên nhân**: Header `Authorization` thiếu hoặc không khớp `MCP_TOKEN`.
- **Xử lý**: Kiểm tra lại `MCP_TOKEN` trong `.env` và cấu hình Header trong client (`Authorization: Bearer <MCP_TOKEN>`).

### Lỗi 2: `refusing to write in "repo-name" on branch "main"`
- **Nguyên nhân**: Thao tác ghi bị chặn do branch hiện tại không khớp `branchPrefix` được quy định cho repo (mặc định `agent/`).
- **Xử lý**: Chuyển sang branch mới bằng `git_branch` (`agent/fix-bug`), hoặc cấu hình `"branchPrefix": "*"` trong `repos.json` cho repo tương ứng.

### Lỗi 3: `denied path: .env`
- **Nguyên nhân**: Truy cập tệp bị Deny-List ngăn chặn để bảo vệ bí mật.
- **Xử lý**: Đây là tính năng bảo mật mặc định. Nếu cần xem hoặc sửa cấu hình mẫu, hãy thao tác với `.env.example` hoặc `.env.template`.

### Lỗi 4: Smoke test báo lỗi `FAIL chan ghi khi branch la main`
- **Nguyên nhân**: File `.env` local của bạn có đặt `DEFAULT_BRANCH_PREFIX=*`, khiến kiểm tra branch guard không bị chặn như kịch bản mong đợi của `smoke.ts`.
- **Xử lý**: Khởi chạy test kèm biến môi trường ghi đè:
  ```powershell
  $env:DEFAULT_BRANCH_PREFIX="agent/"; npm run smoke
  ```
