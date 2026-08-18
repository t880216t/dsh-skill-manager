/**
 * dsh-skill-manager —— 套件更新（覆盖式同步 + 本地改动自动备份）。
 *
 * 套件安装（skill-suite.js）是只增不改的：已存在的条目一律跳过，因此
 * 仓库分支上的后续提交永远到不了用户机器。本模块补上"更新"这一半：
 *
 *   - 指纹记账：每次同步把每个产品拥有的条目的目录指纹写进同步记录，
 *     下次同步据此区分"远端变了"与"用户改了"。
 *   - 覆盖式同步：条目内容与远端不一致就替换；替换前若本地指纹与记录
 *     不符（用户改过，或是本功能之前装的、没有记录），先整目录备份到
 *     `<dsh home>/skill-backups/<时间戳>/<条目>`，再覆盖。
 *   - 远端删除的条目：仅当本地未被改动才移除；改过的保留原地不动。
 *   - revision 短路：先用 `git ls-remote` 取分支 head，与记录一致就
 *     整个跳过，启动时不产生任何下载。取不到 revision（无 git、无网、
 *     私有仓库拒绝）时退化为照常同步，仍靠指纹避免无谓写盘。
 *
 * 用户自己添加的技能永远不在记录里，因此永远不被本模块触碰。
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathExists } from "./skill-files.js";
import { findWrapperRoot } from "./skill-repo.js";
import { SUITE_CONTENT_DIRS, cloneRepoTree, repoCloneUrl } from "./skill-suite.js";
import { extractZipBuffer, parseZip } from "./skill-zip.js";

const execFileAsync = promisify(execFile);

/** `git ls-remote` 超时（毫秒）：只读一行 ref，比克隆宽松得多。 */
const LS_REMOTE_TIMEOUT_MS = 20_000;

/** 同步记录的结构版本：读到别的版本按空记录处理（下次同步重建）。 */
export const SUITE_SYNC_RECORD_VERSION = 1;

/** 同步记录路径：与归档缓存同目录。 */
export function suiteSyncRecordPath(dshHome) {
  return join(dshHome, "cache", "dsh-skill-manager", "suite-sync.json");
}

/**
 * 备份根目录：**在技能根之外**——放进技能根会让备份目录被技能发现
 * 扫成一个技能。
 */
export function suiteBackupRoot(dshHome) {
  return join(dshHome, "skill-backups");
}

/** 仓库在记录中的键：host/owner/name（分支变化不换键，换键会丢指纹）。 */
export function suiteRepoKey({ host, owner, name }) {
  return `${(host ?? "https://github.com").replace(/\/$/, "")}/${owner}/${name}`;
}

/** 备份目录名用的时间戳（文件名安全）。 */
export function backupStamp(at = new Date()) {
  return at.toISOString().replace(/[:.]/g, "-");
}

/**
 * 读同步记录。缺失、读不动、JSON 坏了、版本不认识都按空记录处理——
 * 记录是加速器和"谁拥有什么"的账本，不是不可再生的用户数据。
 * @param {string} dshHome
 * @returns {Promise<{version: number, repos: Record<string, {revision?: string, branch?: string, syncedAt?: string, entries: Record<string, string>}>}>}
 */
export async function readSuiteSyncRecord(dshHome) {
  const empty = { version: SUITE_SYNC_RECORD_VERSION, repos: {} };
  try {
    const parsed = JSON.parse(await readFile(suiteSyncRecordPath(dshHome), "utf8"));
    if (parsed === null || typeof parsed !== "object") return empty;
    if (parsed.version !== SUITE_SYNC_RECORD_VERSION) return empty;
    if (parsed.repos === null || typeof parsed.repos !== "object") return empty;
    return { version: SUITE_SYNC_RECORD_VERSION, repos: parsed.repos };
  } catch {
    return empty;
  }
}

/** 写同步记录；失败静默（写不进不影响本次同步的结果）。 */
export async function writeSuiteSyncRecord(dshHome, record) {
  try {
    const file = suiteSyncRecordPath(dshHome);
    await mkdir(join(dshHome, "cache", "dsh-skill-manager"), { recursive: true });
    await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  } catch {
    // 记录写失败只会让下次同步多做一次比对，不影响正确性
  }
}

async function hashInto(hash, path, prefix) {
  const dirents = await readdir(path, { withFileTypes: true });
  // 名称排序：readdir 的顺序随文件系统变化，指纹必须与它无关。
  for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = join(path, dirent.name);
    const rel = prefix === "" ? dirent.name : `${prefix}/${dirent.name}`;
    if (dirent.isDirectory()) {
      hash.update(`d ${rel}\n`);
      await hashInto(hash, child, rel);
    } else if (dirent.isFile()) {
      const content = await readFile(child);
      hash.update(`f ${rel} ${createHash("sha256").update(content).digest("hex")}\n`);
    }
    // 符号链接等非常规条目不参与指纹：套件树里不该有，出现了也不该被指纹掩盖
  }
}

/**
 * 目录树指纹：相对路径 + 每个文件内容的 sha256，按路径稳定排序。
 * @param {string} path 目录（或不存在的路径）
 * @returns {Promise<string | undefined>} 指纹，路径不存在时 undefined
 */
export async function hashTree(path) {
  if (!(await pathExists(path))) return undefined;
  const hash = createHash("sha256");
  await hashInto(hash, path, "");
  return hash.digest("hex");
}

/**
 * 远端分支 head 的 revision：`git ls-remote`。取不到（无 git、无网、
 * 鉴权失败）返回 undefined，调用方据此退化为照常同步而不是报错。
 * @param {{host?: string, owner: string, name: string, branch?: string}} repo
 * @param {{git?: string}} [options]
 * @returns {Promise<string | undefined>}
 */
export async function remoteRevision(repo, { git = "git" } = {}) {
  const branch = typeof repo.branch === "string" ? repo.branch.trim() : "";
  const ref = branch === "" || branch.toUpperCase() === "HEAD" ? "HEAD" : `refs/heads/${branch}`;
  try {
    const { stdout } = await execFileAsync(git, ["ls-remote", repoCloneUrl(repo), ref], {
      timeout: LS_REMOTE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
    const revision = stdout.toString().trim().split(/\s+/u)[0] ?? "";
    return /^[0-9a-f]{40}$/u.test(revision) ? revision : undefined;
  } catch {
    return undefined;
  }
}

/** 套件树里参与同步的条目：skills/* 与存在的支撑目录。 */
async function suiteEntries(sourceDir, contentDirs) {
  const skillsDir = join(sourceDir, "skills");
  if (!(await pathExists(skillsDir))) {
    throw new Error("套件仓库缺少 skills/ 目录（SUITE_LAYOUT_MISMATCH）");
  }
  const entries = [];
  for (const dirent of await readdir(skillsDir, { withFileTypes: true })) {
    if (dirent.isDirectory()) entries.push({ name: dirent.name, path: join(skillsDir, dirent.name) });
  }
  for (const dir of contentDirs) {
    const path = join(sourceDir, dir);
    if (await pathExists(path)) entries.push({ name: dir, path });
  }
  return entries;
}

/**
 * 把一棵已在磁盘上的仓库树覆盖同步进 destRoot。
 * @param {string} sourceDir 仓库根目录（含 skills/）
 * @param {{
 *   destRoot: string,
 *   backupRoot: string,
 *   owned?: Record<string, string>,
 *   contentDirs?: string[],
 *   stamp?: string
 * }} opts owned 为上次同步记下的条目指纹表
 * @returns {Promise<{entries: Record<string, string>, added: string[], updated: string[], unchanged: string[], removed: string[], retained: string[], backedUp: Array<{name: string, path: string}>}>}
 */
export async function syncSuiteTree(sourceDir, opts) {
  const { destRoot, backupRoot, owned = {}, contentDirs = SUITE_CONTENT_DIRS } = opts;
  const stamp = opts.stamp ?? backupStamp();
  const entries = await suiteEntries(sourceDir, contentDirs);
  await mkdir(destRoot, { recursive: true });

  const result = {
    entries: {},
    added: [],
    updated: [],
    unchanged: [],
    removed: [],
    retained: [],
    backedUp: []
  };

  for (const entry of entries) {
    const dest = join(destRoot, entry.name);
    const sourceHash = await hashTree(entry.path);
    const localHash = await hashTree(dest);

    if (localHash === undefined) {
      await cp(entry.path, dest, { recursive: true });
      result.added.push(entry.name);
      result.entries[entry.name] = sourceHash;
      continue;
    }
    if (localHash === sourceHash) {
      // 内容已一致：不写盘，并把指纹补进记录（本功能之前装的条目由此建账）
      result.unchanged.push(entry.name);
      result.entries[entry.name] = sourceHash;
      continue;
    }
    // 与远端不一致。本地指纹对不上记录 = 用户改过（或没记录），先备份。
    if (owned[entry.name] !== localHash) {
      const backup = join(backupRoot, stamp, entry.name);
      await mkdir(join(backupRoot, stamp), { recursive: true });
      await cp(dest, backup, { recursive: true });
      result.backedUp.push({ name: entry.name, path: backup });
    }
    await rm(dest, { recursive: true, force: true });
    await cp(entry.path, dest, { recursive: true });
    result.updated.push(entry.name);
    result.entries[entry.name] = sourceHash;
  }

  // 远端已删除、但本产品曾经装过的条目
  const present = new Set(entries.map((entry) => entry.name));
  for (const name of Object.keys(owned)) {
    if (present.has(name)) continue;
    const dest = join(destRoot, name);
    const localHash = await hashTree(dest);
    if (localHash === undefined) continue;
    if (localHash === owned[name]) {
      await rm(dest, { recursive: true, force: true });
      result.removed.push(name);
    } else {
      // 用户改过的条目不因远端删除而消失，但也不再由本产品拥有
      result.retained.push(name);
    }
  }

  return result;
}

/**
 * 覆盖同步统一来源（归档缓冲或磁盘目录）。
 * @param {{kind: 'buffer', buffer: Buffer} | {kind: 'dir', dir: string}} source
 * @param {Parameters<typeof syncSuiteTree>[1]} opts
 */
export async function syncSuiteFromSource(source, opts) {
  if (source.kind === "dir") return await syncSuiteTree(source.dir, opts);
  const entries = parseZip(source.buffer);
  const tempDir = await mkdtemp(join(tmpdir(), ".dsh-sm-sync-"));
  try {
    await extractZipBuffer(source.buffer, tempDir);
    const wrapper = findWrapperRoot(entries);
    return await syncSuiteTree(wrapper ? join(tempDir, wrapper) : tempDir, opts);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * 更新一批套件仓库。
 * @param {{
 *   dshHome: string,
 *   destRoot: string,
 *   repos: Array<{host?: string, owner: string, name: string, branch?: string, suite?: boolean}>,
 *   resolveSource: (repo) => Promise<{kind: string, cleanup: () => Promise<void>, branch?: string}>,
 *   git?: string,
 *   force?: boolean,
 *   stamp?: string,
 *   log?: (message: string) => void
 * }} opts force 跳过 revision 短路（手动更新走这条）
 * @returns {Promise<{repos: Array<object>, failures: Array<{repo: string, error: string}>}>}
 */
export async function updateSuiteRepos(opts) {
  const { dshHome, destRoot, repos, resolveSource, git, force = false, log } = opts;
  const emit = log ?? (() => {});
  const stamp = opts.stamp ?? backupStamp();
  const record = await readSuiteSyncRecord(dshHome);
  const targets = repos.filter((repo) => repo.suite === true);
  const summaries = [];
  const failures = [];

  for (const repo of targets) {
    const key = suiteRepoKey(repo);
    const label = `${repo.owner}/${repo.name}`;
    const previous = record.repos[key];
    try {
      const revision = await remoteRevision(repo, git === undefined ? undefined : { git });
      if (!force
        && revision !== undefined
        && previous !== undefined
        && previous.revision === revision
        && previous.entries !== undefined) {
        summaries.push({
          owner: repo.owner,
          name: repo.name,
          branch: repo.branch ?? "",
          revision,
          upToDate: true,
          added: [],
          updated: [],
          unchanged: Object.keys(previous.entries),
          removed: [],
          retained: [],
          backedUp: []
        });
        continue;
      }

      const source = await resolveSource(repo);
      let synced;
      try {
        synced = await syncSuiteFromSource(source, {
          destRoot,
          backupRoot: suiteBackupRoot(dshHome),
          owned: previous?.entries ?? {},
          stamp
        });
      } finally {
        await source.cleanup();
      }

      record.repos[key] = {
        ...(revision === undefined ? {} : { revision }),
        branch: repo.branch ?? source.branch ?? "",
        syncedAt: new Date().toISOString(),
        entries: synced.entries
      };
      const changed = synced.added.length + synced.updated.length + synced.removed.length;
      if (changed > 0 || synced.backedUp.length > 0) {
        emit(`skill-manager: 更新 ${label} 完成（新增 ${synced.added.length} 项，替换 ${synced.updated.length} 项，`
          + `移除 ${synced.removed.length} 项，备份 ${synced.backedUp.length} 项，保留本地改动 ${synced.retained.length} 项）`);
      }
      summaries.push({
        owner: repo.owner,
        name: repo.name,
        branch: repo.branch ?? "",
        ...(revision === undefined ? {} : { revision }),
        upToDate: changed === 0,
        added: synced.added,
        updated: synced.updated,
        unchanged: synced.unchanged,
        removed: synced.removed,
        retained: synced.retained,
        backedUp: synced.backedUp
      });
    } catch (err) {
      failures.push({ repo: label, error: err?.message ?? String(err) });
      emit(`skill-manager: 更新 ${label} 失败：${err?.message ?? err}`);
    }
  }

  if (targets.length > 0) await writeSuiteSyncRecord(dshHome, record);
  return { repos: summaries, failures };
}
