/**
 * dsh-skill-manager —— 首次启动一次性自动安装。
 *
 * 目标：全新应用数据目录首次启动时，把预置的套件仓库（suite: true）
 * 自动拉取安装到用户技能根，用户无需任何手工操作。
 *
 * 成功后写标记文件（<dshHome>/cache/dsh-skill-manager/auto-install.done），
 * 之后的启动直接跳过；任一仓库失败（断网、鉴权、地址错误）不写标记，
 * 下次启动自动重试，失败只记录、不阻断应用启动。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 标记文件路径：与归档缓存同目录。 */
export function autoInstallMarkerPath(dshHome) {
  return join(dshHome, "cache", "dsh-skill-manager", "auto-install.done");
}

/**
 * 执行一次性自动安装。
 * @param {{
 *   dshHome: string,
 *   destRoot: string,
 *   repos: Array<{host?: string, owner: string, name: string, branch?: string, suite?: boolean}>,
 *   fetchArchive: (repo) => Promise<{buffer: Buffer, branch: string}>,
 *   installSuite?: (buffer, opts) => Promise<{installed: string[], skipped: string[]}>,
 *   log?: (message: string) => void
 * }} opts
 * @returns {Promise<{ran: boolean, installed: string[], failures: Array<{repo: string, error: string}>}>}
 */
export async function runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive, cloneTree, installSuite, log }) {
  const marker = autoInstallMarkerPath(dshHome);
  const emit = log ?? (() => {});
  try {
    await readFile(marker);
    return { ran: false, installed: [], failures: [] };
  } catch {
    // 无标记：首次（或上次失败后的）启动，执行安装。
  }
  const suiteModule = await import("./skill-suite.js");
  const suite = installSuite ?? suiteModule.installSuiteFromRepoBuffer;
  // 归档端点可被实例网关拒绝（406 等）；git 智能 HTTP 通常仍然可用。
  const clone = cloneTree ?? ((repo) =>
    suiteModule.cloneRepoTree({ url: suiteModule.repoCloneUrl(repo), branch: repo.branch }));
  const targets = repos.filter((repo) => repo.suite === true);
  const installed = [];
  const failures = [];
  for (const repo of targets) {
    const label = `${repo.owner}/${repo.name}`;
    try {
      let result;
      try {
        const { buffer } = await fetchArchive(repo);
        result = await suite(buffer, { destRoot });
      } catch (archiveError) {
        emit(`skill-manager: ${label} 归档拉取失败（${archiveError?.message ?? archiveError}），回退 git clone`);
        const { dir, cleanup } = await clone(repo);
        try {
          result = await suiteModule.installSuiteFromRepoDir(dir, { destRoot });
        } finally {
          await cleanup();
        }
      }
      installed.push(...result.installed);
      emit(`skill-manager: 自动安装 ${label} 完成（${result.installed.length} 项，跳过 ${result.skipped.length} 项）`);
    } catch (err) {
      failures.push({ repo: label, error: err?.message ?? String(err) });
      emit(`skill-manager: 自动安装 ${label} 失败：${err?.message ?? err}`);
    }
  }
  if (targets.length > 0 && failures.length === 0) {
    await mkdir(join(dshHome, "cache", "dsh-skill-manager"), { recursive: true });
    await writeFile(marker, JSON.stringify({ at: new Date().toISOString(), installed }, null, 2), "utf8");
  }
  return { ran: true, installed, failures };
}
