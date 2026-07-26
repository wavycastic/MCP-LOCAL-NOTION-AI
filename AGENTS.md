# AGENTS.md — lam viec tren chinh repo local-repo-mcp

File nay danh cho agent/ban sua **server MCP nay**. Instructions cho agent lam viec tren cac repo
duoc mount nam trong `README.md`.

## Kien truc

```
src/config.ts          env, khong chua logic
src/repos.ts           REPO REGISTRY — nguon su that ve repo nao ton tai va quyen gi
src/toolchain.ts       doan build/test cmd tu file dac trung o root repo
src/security/paths.ts  chroot theo TUNG repo + deny-list
src/exec.ts            spawn khong shell, cwd bat buoc
src/git.ts             hai cua kiem tra truoc khi ghi
src/lock.ts            mutex theo tung repo
src/jobs.ts            job chay dai (build/test background), van di qua mutex
src/log.ts             audit.log: redact noi dung file + rotate
src/tools/*.ts         moi tool: schema zod + handler
src/tools/index.ts     registry: annotations, lock, audit, isError
```

Moi tool bat dau bang `resolveRepo(a.repo)`. Khong tool nao duoc gia dinh "repo mac dinh" —
`resolveRepo` tu xu ly truong hop chi co 1 repo.

## Nguyen tac khong duoc pha

1. **Moi path tu client phai di qua `src/security/paths.ts`, kem root cua dung repo do.**
   `safeResolve(repo.root, rel)` cho path phai ton tai, `safeResolveNew` cho path se duoc tao,
   `safeResolveDir` cho thu muc (cho phep repo root). Khong bao gio truyen `WORKSPACE_ROOT` lam root —
   lam vay la mo duong cho `../` di cheo giua cac repo.
2. **Khong bao gio `shell: true`.** Moi lenh chay qua `run(argv, { cwd })` voi argv co dinh.
3. **Khong tool nao nhan argv/flag tuy y**, ke ca tu `repos.json`: `build`/`test`/`reindex` phai la
   mang argv va duoc validate trong `repos.ts`.
4. **Moi tool co ghi phai goi `assertWritableBranch(repo)` o dong dau.** Ham do kiem tra ca
   `repo.write` va branch prefix. Khong co ngoai le.
5. **Repo mac dinh la chi-doc.** Repo tu dong tim thay chi ghi duoc khi `AUTO_DISCOVERED_WRITE=true`;
   repo trong `repos.json` chi ghi duoc khi `"write": true`. Dung doi mac dinh nay.
6. **Khong them `git reset --hard`, `git checkout -- .`, `git clean`, `git push --force`.**
   Local la nguon su that; cac lenh nay xoa dung thu agent vua viet.
   Ngoai le duy nhat da can nhac: `git_restore` chay `git checkout HEAD -- <cac file cu the>`.
   No BAT BUOC path-scoped — chan `.`, `..`, `/`, wildcard, va chan ca file chua track.
   Dung mo rong no thanh dang nhan thu muc hay pattern.
7. **Khong co `write_file` ghi de ca file.** `create_file` chi tao file moi, `edit_file` chi
   string-replace. Day la thiet ke, khong phai thieu sot.
8. **Ten repo la dinh danh, phai duy nhat.** `assertUniqueNames` trong `repos.ts` lam server sap ngay
   khi trung ten. Dung "sua" bang cach tu them hau to — chon sai repo mot cach im lang te hon nhieu
   so voi loi cau hinh hien ro.
9. **`audit.log` khong duoc chua noi dung file.** Truong `content`/`new_str`/`old_str` chi ghi do dai
   (`redactForAudit`). Them truong moi co the chua du lieu lon thi phai them vao danh sach elide.

## Them mot tool moi

1. Tao `src/tools/<name>.ts`: export `<name>Schema` + handler.
2. Schema **luon co** `repo: z.string().optional().describe("Ten repo (xem list_repos)")`.
3. Handler: `const repo = resolveRepo(a.repo)` truoc tien; neu co ghi thi
   `await assertWritableBranch(repo)` ngay sau. Tra ve plain object, **luon kem `repo: repo.name`**
   de agent khong lam lan ket qua giua cac repo.
4. Dang ky trong `src/tools/index.ts` bang `reg(...)`:
   - `{ readOnly: true }` cho tool chi doc — khong bi serialize qua mutex.
   - bo `readOnly` cho tool co side effect — chay trong `withLock(repo, ...)`.
   - `{ destructive: true }` cho tool xoa du lieu hoac bo thay doi.
5. Description la giao dien that voi agent. Viet ro **khi nao dung** va **khi nao dung tool khac**.
   Description kem lam agent dung sai tool, khong phai loi code.
6. Them assertion vao `scripts/smoke.ts` — ca duong thanh cong va duong bi chan.

## Lenh chay dai

Tool chay lenh > 1 phut nen ho tro `background: true`: goi `startJob(repo.name, repo.root, argv)`
trong `src/jobs.ts` va tra ve `job_id`. Job phai chay **trong `withLock`** — bo lock chi vi doi sang
bat dong bo la mo lai dung cai race ma mutex sinh ra de chan.

## Ho tro mot toolchain moi

Them nhanh vao `detectToolchain` trong `src/toolchain.ts`. Chi tra ve argv co dinh, va chi khi
tin cay: neu doan sai thi tot hon la tra `undefined` de `run_build` bao loi ro rang
("khai bao build trong repos.json") thay vi chay mot lenh vo nghia.

## Loi va log

- Handler cu viec `throw new Error("...")`. Registry bat, ghi `audit.log`, tra `isError: true` kem
  message — khong lam vo transport.
- Message loi phai noi ro **buoc tiep theo**, vi agent doc message do de retry. Vd:
  "khong biet repo X. Dang co: A, B, C" hoac "repo Y la chi-doc. Dat write: true trong repos.json".
- `audit.log` la ban ghi duy nhat ve viec agent da lam gi. Khong bao gio tat.

## Truoc khi commit

```bash
npm run typecheck
npm run smoke
```

CI chay dung hai lenh nay tren main va moi PR. Luu y `scripts/` khong nam trong `rootDir` cua
`tsconfig.json` nen `typecheck` **khong** kiem smoke test — loi trong smoke chi lo ra khi chay.

Smoke test tu tao repo git tam va tu ghi `user.email`/`user.name` vao `.git/config` cua chung.
Dung dua vao gitconfig global: runner CI khong co, va `exec.ts` loc env nen `git -c` cua tien trinh
cha khong truyen sang lenh do tool goi.
