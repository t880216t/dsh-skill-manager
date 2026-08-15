import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeZip } from "./helpers/zip-builder.js";
import { archiveUrl, isValidRepoOwnerPath, validateRepoRef } from "../lib/skill-repo.js";
import { installSuiteFromRepoBuffer } from "../lib/skill-suite.js";
import { runAutoInstallOnce } from "../lib/auto-install.js";

const SKILL_MD = (name) => `---\nname: ${name}\ndescription: d\n---\n\n正文。`;

// ── host 感知的归档地址 ────────────────────────────────────────────────────

test("archiveUrl：默认 GitHub 形状", () => {
  assert.equal(
    archiveUrl({ owner: "anthropics", name: "skills", branch: "main" }),
    "https://github.com/anthropics/skills/archive/refs/heads/main.zip"
  );
});

test("archiveUrl：自定义 host 使用 GitLab 归档形状（支持子组 owner）", () => {
  assert.equal(
    archiveUrl({
      host: "https://git.vemic.com",
      owner: "mic-share/mic-ai-test",
      name: "supertester",
      branch: "master"
    }),
    "https://git.vemic.com/mic-share/mic-ai-test/supertester/-/archive/master/supertester-master.zip"
  );
});

test("isValidRepoOwnerPath：子组路径逐段校验", () => {
  assert.equal(isValidRepoOwnerPath("mic-share/mic-ai-test"), true);
  assert.equal(isValidRepoOwnerPath("single"), true);
  assert.equal(isValidRepoOwnerPath("bad//seg"), false);
  assert.equal(isValidRepoOwnerPath("/lead"), false);
  assert.equal(isValidRepoOwnerPath("trail/"), false);
  assert.equal(isValidRepoOwnerPath("has space/x"), false);
  assert.equal(isValidRepoOwnerPath("../up"), false);
});

test("validateRepoRef：带 host 时接受子组 owner，纯 GitHub 时仍拒绝", () => {
  assert.doesNotThrow(() =>
    validateRepoRef("mic-share/mic-ai-test", "supertester", "master", { allowSubgroups: true })
  );
  assert.throws(() => validateRepoRef("mic-share/mic-ai-test", "supertester", "master"), /INVALID_REPO_REF/);
});

// ── 套件安装：整树内容集（skills/* 平铺 + 支撑目录同装）───────────────────

async function suiteArchive() {
  return makeZip([
    { name: "supertester-master/", dir: true },
    { name: "supertester-master/skills/", dir: true },
    { name: "supertester-master/skills/using-supertester/", dir: true },
    { name: "supertester-master/skills/using-supertester/SKILL.md", data: SKILL_MD("using-supertester") },
    { name: "supertester-master/skills/shared/", dir: true },
    { name: "supertester-master/skills/shared/conduct.md", data: "约定。" },
    { name: "supertester-master/scripts/", dir: true },
    { name: "supertester-master/scripts/st.py", data: "print('st')\n" },
    { name: "supertester-master/templates/", dir: true },
    { name: "supertester-master/templates/a.tpl", data: "t" },
    { name: "supertester-master/README.md", data: "非内容目录，不安装" }
  ]);
}

test("installSuiteFromRepoBuffer：skills/* 平铺进 destRoot，支撑目录并排落位", async () => {
  const destRoot = await mkdtemp(join(tmpdir(), "dsh-suite-"));
  const result = await installSuiteFromRepoBuffer(await suiteArchive(), { destRoot });
  assert.deepEqual(result.installed.sort(), ["scripts", "shared", "templates", "using-supertester"]);
  assert.deepEqual(result.skipped, []);
  assert.equal(await readFile(join(destRoot, "using-supertester", "SKILL.md"), "utf8"), SKILL_MD("using-supertester"));
  assert.equal(await readFile(join(destRoot, "scripts", "st.py"), "utf8"), "print('st')\n");
  assert.equal(await readFile(join(destRoot, "shared", "conduct.md"), "utf8"), "约定。");
  const entries = (await readdir(destRoot)).sort();
  assert.deepEqual(entries, ["scripts", "shared", "templates", "using-supertester"]);
});

test("installSuiteFromRepoBuffer：已存在的条目跳过不覆盖", async () => {
  const destRoot = await mkdtemp(join(tmpdir(), "dsh-suite-"));
  await mkdir(join(destRoot, "using-supertester"), { recursive: true });
  await writeFile(join(destRoot, "using-supertester", "SKILL.md"), "本地修改版");
  const result = await installSuiteFromRepoBuffer(await suiteArchive(), { destRoot });
  assert.deepEqual(result.skipped, ["using-supertester"]);
  assert.equal(await readFile(join(destRoot, "using-supertester", "SKILL.md"), "utf8"), "本地修改版");
  assert.equal(await readFile(join(destRoot, "scripts", "st.py"), "utf8"), "print('st')\n");
});

// ── 首次启动一次性自动安装 ────────────────────────────────────────────────

test("runAutoInstallOnce：无标记时安装 suite 仓库并写标记，二次调用跳过", async () => {
  const dshHome = await mkdtemp(join(tmpdir(), "dsh-home-"));
  const destRoot = join(dshHome, "skills");
  const calls = [];
  const fetchArchive = async (repo) => {
    calls.push(repo.name);
    return { buffer: await suiteArchive(), branch: repo.branch };
  };
  const repos = [
    { host: "https://git.vemic.com", owner: "mic-share/mic-ai-test", name: "supertester", branch: "master", suite: true },
    { owner: "anthropics", name: "skills", branch: "main" }
  ];
  const first = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive });
  assert.equal(first.ran, true);
  assert.deepEqual(calls, ["supertester"]);
  assert.equal(await readFile(join(destRoot, "scripts", "st.py"), "utf8"), "print('st')\n");

  const second = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive });
  assert.equal(second.ran, false);
  assert.deepEqual(calls, ["supertester"]);
});

test("runAutoInstallOnce：拉取失败不写标记，下次启动重试", async () => {
  const dshHome = await mkdtemp(join(tmpdir(), "dsh-home-"));
  const destRoot = join(dshHome, "skills");
  let attempts = 0;
  const failing = async () => {
    attempts += 1;
    throw new Error("下载失败（DOWNLOAD_FAILED）：模拟断网");
  };
  const failingClone = async () => { throw new Error("克隆失败（CLONE_FAILED）：模拟断网"); };
  const repos = [{ host: "https://git.vemic.com", owner: "g/s", name: "supertester", branch: "master", suite: true }];
  const first = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive: failing, cloneTree: failingClone });
  assert.equal(first.ran, true);
  assert.equal(first.failures.length, 1);
  const second = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive: failing, cloneTree: failingClone });
  assert.equal(second.ran, true);
  assert.equal(attempts, 2);
});

// ── git clone 回退（归档端点被网关拒绝时的套件拉取路径）───────────────────

test("cloneRepoTree：从本地 git 仓库浅克隆出可安装的树", async () => {
  const { execFileSync } = await import("node:child_process");
  const repo = await mkdtemp(join(tmpdir(), "dsh-src-repo-"));
  execFileSync("git", ["init", "-q", "-b", "master", repo]);
  await mkdir(join(repo, "skills", "using-supertester"), { recursive: true });
  await writeFile(join(repo, "skills", "using-supertester", "SKILL.md"), SKILL_MD("using-supertester"));
  await mkdir(join(repo, "scripts"), { recursive: true });
  await writeFile(join(repo, "scripts", "st.py"), "print('st')\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

  const { cloneRepoTree } = await import("../lib/skill-suite.js");
  const { dir, cleanup } = await cloneRepoTree({ url: repo, branch: "master" });
  try {
    assert.equal(await readFile(join(dir, "scripts", "st.py"), "utf8"), "print('st')\n");
  } finally {
    await cleanup();
  }
});

test("installSuiteFromRepoDir：与归档安装同构", async () => {
  const source = await mkdtemp(join(tmpdir(), "dsh-suite-src-"));
  await mkdir(join(source, "skills", "using-supertester"), { recursive: true });
  await writeFile(join(source, "skills", "using-supertester", "SKILL.md"), SKILL_MD("using-supertester"));
  await mkdir(join(source, "scripts"), { recursive: true });
  await writeFile(join(source, "scripts", "st.py"), "print('st')\n");

  const { installSuiteFromRepoDir } = await import("../lib/skill-suite.js");
  const destRoot = await mkdtemp(join(tmpdir(), "dsh-suite-"));
  const result = await installSuiteFromRepoDir(source, { destRoot });
  assert.deepEqual(result.installed.sort(), ["scripts", "using-supertester"]);
  assert.equal(await readFile(join(destRoot, "scripts", "st.py"), "utf8"), "print('st')\n");
});

test("runAutoInstallOnce：归档失败时回退 git clone，成功后写标记", async () => {
  const dshHome = await mkdtemp(join(tmpdir(), "dsh-home-"));
  const destRoot = join(dshHome, "skills");
  const source = await mkdtemp(join(tmpdir(), "dsh-suite-src-"));
  await mkdir(join(source, "skills", "using-supertester"), { recursive: true });
  await writeFile(join(source, "skills", "using-supertester", "SKILL.md"), SKILL_MD("using-supertester"));

  const failingArchive = async () => { throw new Error("下载失败（DOWNLOAD_FAILED）状态 406"); };
  let cloned = 0;
  const cloneTree = async () => {
    cloned += 1;
    return { dir: source, cleanup: async () => {} };
  };
  const repos = [{ host: "https://git.vemic.com", owner: "g/s", name: "supertester", branch: "master", suite: true }];
  const first = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive: failingArchive, cloneTree });
  assert.equal(first.failures.length, 0);
  assert.equal(cloned, 1);
  assert.equal(await readFile(join(destRoot, "using-supertester", "SKILL.md"), "utf8"), SKILL_MD("using-supertester"));
  const second = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive: failingArchive, cloneTree });
  assert.equal(second.ran, false);
});

// ── 目录树版发现/单技能安装（discover/install 的 git clone 回退共用核心）──

test("discoverFromTree：从磁盘仓库树扫描可发现技能", async () => {
  const scan = await mkdtemp(join(tmpdir(), "dsh-tree-"));
  await mkdir(join(scan, "skills", "using-supertester"), { recursive: true });
  await writeFile(join(scan, "skills", "using-supertester", "SKILL.md"), SKILL_MD("using-supertester"));
  const { discoverFromTree } = await import("../lib/skill-repo.js");
  const skills = await discoverFromTree(scan, "mic-share/mic-ai-test", "supertester", "feat/x");
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, "using-supertester");
  assert.equal(skills[0].directory, "skills/using-supertester");
});

test("installFromRepoTree：从磁盘仓库树安装单个技能", async () => {
  const scan = await mkdtemp(join(tmpdir(), "dsh-tree-"));
  await mkdir(join(scan, "skills", "using-supertester"), { recursive: true });
  await writeFile(join(scan, "skills", "using-supertester", "SKILL.md"), SKILL_MD("using-supertester"));
  const destRoot = await mkdtemp(join(tmpdir(), "dsh-dest-"));
  const { installFromRepoTree } = await import("../lib/skill-repo.js");
  const result = await installFromRepoTree(scan, {
    owner: "mic-share/mic-ai-test", name: "supertester", branch: "feat/x",
    directory: "skills/using-supertester", destRoot
  });
  assert.equal(result.conflict, undefined);
  assert.equal(result.name, "using-supertester");
  assert.equal(await readFile(join(destRoot, "using-supertester", "SKILL.md"), "utf8"), SKILL_MD("using-supertester"));
});
