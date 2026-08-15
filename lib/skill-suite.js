/**
 * dsh-skill-manager —— 套件安装（整树内容集）。
 *
 * Supertester 这类技能套件的 skill 依赖同仓库的支撑目录（scripts/、
 * templates/ 等），按单个技能目录安装会丢失它们。套件安装把仓库的
 * `skills/*` 条目平铺进 destRoot 顶层（供技能发现），并把支撑目录
 * 原样并排落位——技能说明书里"安装目录下 scripts/st.py"的相对约定
 * 因此继续成立。已存在的同名条目跳过不覆盖（保护本地修改）。
 *
 * 拉取有两条路径：仓库 zip 归档（installSuiteFromRepoBuffer），以及
 * 归档端点被实例网关拒绝时的浅 git clone（cloneRepoTree +
 * installSuiteFromRepoDir）——git 智能 HTTP 通常不受归档限制影响。
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { extractZipBuffer, parseZip } from "./skill-zip.js";
import { pathExists } from "./skill-files.js";
import { findWrapperRoot } from "./skill-repo.js";

const execFileAsync = promisify(execFile);

/** 套件仓库里随 skills/ 一起安装的支撑目录（存在才装）。 */
export const SUITE_CONTENT_DIRS = ["scripts", "templates", "agents", "assets"];

/** git clone 超时（毫秒）：内网浅克隆的宽松上限。 */
const CLONE_TIMEOUT_MS = 120_000;

async function copyEntry(source, destRoot, entryName, installed, skipped) {
  const dest = join(destRoot, entryName);
  if (await pathExists(dest)) {
    skipped.push(entryName);
    return;
  }
  await cp(source, dest, { recursive: true });
  installed.push(entryName);
}

/**
 * 从已在磁盘上的仓库树安装整套内容集到 destRoot。
 * @param {string} sourceDir 仓库根目录（含 skills/）
 * @param {{destRoot: string, contentDirs?: string[]}} opts
 * @returns {Promise<{installed: string[], skipped: string[]}>}
 */
export async function installSuiteFromRepoDir(sourceDir, { destRoot, contentDirs = SUITE_CONTENT_DIRS }) {
  const skillsDir = join(sourceDir, "skills");
  if (!(await pathExists(skillsDir))) {
    throw new Error("套件仓库缺少 skills/ 目录（SUITE_LAYOUT_MISMATCH）");
  }
  await mkdir(destRoot, { recursive: true });
  const installed = [];
  const skipped = [];
  for (const dirent of await readdir(skillsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    await copyEntry(join(skillsDir, dirent.name), destRoot, dirent.name, installed, skipped);
  }
  for (const dir of contentDirs) {
    const source = join(sourceDir, dir);
    if (!(await pathExists(source))) continue;
    await copyEntry(source, destRoot, dir, installed, skipped);
  }
  return { installed, skipped };
}

/**
 * 从仓库归档安装整套内容集到 destRoot。
 * @param {Buffer} buffer 仓库归档
 * @param {{destRoot: string, contentDirs?: string[]}} opts
 * @returns {Promise<{installed: string[], skipped: string[]}>}
 */
export async function installSuiteFromRepoBuffer(buffer, opts) {
  const entries = parseZip(buffer);
  const tempDir = await mkdtemp(join(tmpdir(), ".dsh-sm-suite-"));
  try {
    await extractZipBuffer(buffer, tempDir);
    const wrapper = findWrapperRoot(entries);
    const scanDir = wrapper ? join(tempDir, wrapper) : tempDir;
    return await installSuiteFromRepoDir(scanDir, opts);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * 浅克隆仓库到临时目录（无凭据提示；分支缺省用远端默认分支）。
 * @param {{url: string, branch?: string, git?: string}} opts
 * @returns {Promise<{dir: string, cleanup: () => Promise<void>}>}
 */
export async function cloneRepoTree({ url, branch, git = "git" }) {
  const dir = await mkdtemp(join(tmpdir(), ".dsh-sm-clone-"));
  const args = ["clone", "--quiet", "--depth", "1"];
  if (typeof branch === "string" && branch.length > 0 && branch.toUpperCase() !== "HEAD") {
    args.push("--branch", branch);
  }
  args.push(url, dir);
  try {
    await execFileAsync(git, args, {
      timeout: CLONE_TIMEOUT_MS,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
    });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw new Error(`克隆失败（CLONE_FAILED）：${err?.stderr?.toString().trim() || err?.message || err}`);
  }
  return {
    dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * 从统一来源（归档缓冲或磁盘目录）安装套件内容集：kind 分派到对应实现，
 * 已存在的条目跳过，因此可在每次发现套件仓库时幂等补装缺失技能。
 * @param {{kind: 'buffer', buffer: Buffer} | {kind: 'dir', dir: string}} source
 * @param {{destRoot: string, contentDirs?: string[]}} opts
 * @returns {Promise<{installed: string[], skipped: string[]}>}
 */
export async function installSuiteFromSource(source, opts) {
  return source.kind === "buffer"
    ? await installSuiteFromRepoBuffer(source.buffer, opts)
    : await installSuiteFromRepoDir(source.dir, opts);
}

/** 仓库条目的匿名 git URL：`<host>/<owner>/<name>.git`。 */
export function repoCloneUrl({ host, owner, name }) {
  const base = host ?? "https://github.com";
  return `${base.replace(/\/$/, "")}/${owner}/${name}.git`;
}
