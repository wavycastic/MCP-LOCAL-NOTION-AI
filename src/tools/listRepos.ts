import { allRepos, invalidateRepoCache } from "../repos.js"

/**
 * Tool dau tien agent nen goi: cho biet co nhung repo nao, repo nao cho ghi,
 * toolchain la gi. Moi tool khac nhan tham so `repo` la ten o day.
 */
export async function listRepos(a: { refresh?: boolean } = {}) {
	if (a.refresh) invalidateRepoCache()
	const repos = allRepos()
	return {
		count: repos.length,
		repos: repos.map((r) => ({
			name: r.name,
			write: r.write,
			branch_prefix: r.write ? r.branchPrefix + "*" : null,
			toolchain: r.toolchain,
			can_build: Boolean(r.build),
			can_test: Boolean(r.test),
			source: r.source,
		})),
	}
}
