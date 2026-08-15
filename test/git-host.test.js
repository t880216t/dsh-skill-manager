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
  const repos = [{ host: "https://git.vemic.com", owner: "g/s", name: "supertester", branch: "master", suite: true }];
  const first = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive: failing });
  assert.equal(first.ran, true);
  assert.equal(first.failures.length, 1);
  const second = await runAutoInstallOnce({ dshHome, destRoot, repos, fetchArchive: failing });
  assert.equal(second.ran, true);
  assert.equal(attempts, 2);
});
