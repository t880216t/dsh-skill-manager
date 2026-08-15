/**
 * dsh-skill-manager —— 套件安装（整树内容集）。
 *
 * Supertester 这类技能套件的 skill 依赖同仓库的支撑目录（scripts/、
 * templates/ 等），按单个技能目录安装会丢失它们。套件安装把仓库的
 * `skills/*` 条目平铺进 destRoot 顶层（供技能发现），并把支撑目录
 * 原样并排落位——技能说明书里"安装目录下 scripts/st.py"的相对约定
 * 因此继续成立。已存在的同名条目跳过不覆盖（保护本地修改）。
 */
import { cp, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractZipBuffer, parseZip } from "./skill-zip.js";
import { pathExists } from "./skill-files.js";
import { findWrapperRoot } from "./skill-repo.js";

/** 套件仓库里随 skills/ 一起安装的支撑目录（存在才装）。 */
export const SUITE_CONTENT_DIRS = ["scripts", "templates", "agents", "assets"];

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
 * 从仓库归档安装整套内容集到 destRoot。
 * @param {Buffer} buffer 仓库归档
 * @param {{destRoot: string, contentDirs?: string[]}} opts
 * @returns {Promise<{installed: string[], skipped: string[]}>}
 */
export async function installSuiteFromRepoBuffer(buffer, { destRoot, contentDirs = SUITE_CONTENT_DIRS }) {
  const entries = parseZip(buffer);
  const tempDir = await mkdtemp(join(tmpdir(), ".dsh-sm-suite-"));
  try {
    await extractZipBuffer(buffer, tempDir);
    const wrapper = findWrapperRoot(entries);
    const scanDir = wrapper ? join(tempDir, wrapper) : tempDir;
    const skillsDir = join(scanDir, "skills");
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
      const source = join(scanDir, dir);
      if (!(await pathExists(source))) continue;
      await copyEntry(source, destRoot, dir, installed, skipped);
    }
    return { installed, skipped };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
