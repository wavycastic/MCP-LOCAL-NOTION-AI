# AGENTS.md — lam viec tren chinh repo cvaut-local-mcp

File nay danh cho agent/ban sua **server MCP nay**, khong phai repo CV-AUT.
Instructions cho agent lam viec tren CV-AUT nam trong `README.md`.

## Nguyen tac khong duoc pha

1. **Moi path tu ben ngoai phai di qua `src/security/paths.ts`.** Khong `readFileSync`/`writeFileSync`
   truc tiep tren string do client gui. `safeResolve` cho path phai ton tai, `safeResolveNew` cho path
   se duoc tao, `safeResolveDir` cho thu muc (cho phep repo root).
2. **Khong bao gio `shell: true`.** Moi lenh chay qua `run(argv)` trong `src/exec.ts` voi argv da co dinh.
3. **Khong tool nao nhan argv/flag tuy y.** Muon them tham so thi validate bang zod hep (xem
   `runTestsSchema` — filter co regex allowlist).
4. **Moi tool co ghi phai goi `assertWritableBranch()` o dong dau.** Khong co ngoai le.
5. **Khong them `git reset --hard`, `git checkout -- .`, `git clean`, hay `git push --force`.**
   Chieu B: local la nguon su that, cac lenh nay xoa dung thu agent vua viet.
6. **Khong co `write_file` ghi de ca file.** `create_file` chi tao file moi, `edit_file` chi
   string-replace. Day la thiet ke, khong phai thieu sot.

## Them mot tool moi

1. Tao `src/tools/<name>.ts`: export `<name>Schema` (object cac zod field) + ham handler.
2. Handler nhan 1 object args da validate, tra ve plain object JSON-serializable.
3. Dang ky trong `src/tools/index.ts` bang `reg(...)`:
   - `{ readOnly: true }` cho tool chi doc — se **khong** bi serialize qua mutex.
   - bo `readOnly` cho tool co side effect — se chay trong `withLock`.
   - `{ destructive: true }` cho tool xoa du lieu.
4. Description la giao dien that voi agent. Viet ro **khi nao dung** va **khi nao dung tool khac**
   (vd: ripgrep vs GitNexus query). Description kem lam agent dung sai tool, khong phai loi code.

## Loi va log

- Handler cu viec `throw new Error("...")`. Registry bat, ghi `audit.log`, va tra ve `isError: true`
  kem message de agent tu sua — khong lam vo transport.
- Message loi nen noi ro **buoc tiep theo** (vd: "old_str khop 3 cho... mo rong old_str hoac dat
  replace_all=true"), vi agent doc message do de retry.
- `audit.log` la ban ghi duy nhat ve viec agent da lam gi. Khong bao gio tat.

## Truoc khi commit

```bash
npx tsc --noEmit
```

CI chay dung lenh nay tren main va moi PR.
