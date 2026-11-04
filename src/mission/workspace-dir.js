// src/mission/workspace-dir.js — 用户工作区里 `.dsh/` 目录的唯一创建处。
//
// 第一性原理：为什么这件事需要一个专门的模块
//
//   DshCockpit 会在用户的工作区里写 `<ws>/.dsh/**`（mission / grants / artifacts /
//   audit / ui-seen…）。那是**用户的 git 仓库**，不是我们的数据目录。
//
//   如果什么都不做，用户 `git status` 就会看到一堆 `.dsh/` 下的未跟踪文件，
//   他要么手动加到 .gitignore（多数人不会），要么在一个 PR 里不小心提交进去
//   （里面可能有他的 Mission 记录、决策、审计）。
//   **这等于我们往别人的仓库里塞东西，还让他收拾。**
//
//   所以：**每次创建 `.dsh/` 时，顺手放一个 `.gitignore` 把整个目录排除掉。**
//
//   为什么放在 `<ws>/.dsh/.gitignore` 而不是改用户根目录的 `.gitignore`：
//     · 不动用户的文件（那是他的仓库，我们只是在里面放自己的数据）
//     · `.gitignore` 里的 `*` 对**该目录及其子目录**生效，一条就够
//     · 删掉 `.dsh/` 就一切复原，没有残留
//
//   为什么这个模块存在（而不是各模块各写一遍）：
//     写入点有 4+ 处（audit / brief / event-log / grant），
//     每处都"记得顺手写 .gitignore"是不可能的 —— 迟早漏一处，
//     而漏的那处会安静地在用户仓库里留下未跟踪文件。
//     所以创建目录这件事**只能有一个实现**。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** `.dsh/` 下要放的自忽略文件内容。 */
//
// 只写 `*` —— **不要**加 `!.gitignore`。
//
// 这是实测出来的，不是偏好：
//   `*` + `!.gitignore` 会让 git 认为该目录里有"该被跟踪的文件"，
//   于是 `git status` 仍然显示 `?? .dsh/`（目录本身变成未跟踪）。
//   只有纯 `*` 才能让整个目录从 git status 里彻底消失。
//   （test/mission-workspace-gitignore.test.js 里那条"git ACTUALLY ignores"
//    就是为此存在的 —— 只检查文件存在是不够的，必须让 git 真的闭嘴。）
//
// 代价：`.gitignore` 自己也被忽略了。可以接受 ——
// 它只是我们的标记文件，用户不会去编辑它；而"git status 干净"更重要。
const SELF_IGNORE = '# DshCockpit 运行时数据 —— 不属于你的项目，不要提交。\n'
  + '# 这个文件由 DshCockpit 自动维护（本目录整体被忽略）。\n'
  + '*\n';

/**
 * 确保 `<workspaceDir>/.dsh/` 存在，并带上自我忽略的 `.gitignore`。
 *
 * @param {string} workspaceDir 工作区根
 * @returns {string} `.dsh` 目录的绝对路径
 */
function ensureDshDir(workspaceDir) {
  if (typeof workspaceDir !== 'string' || workspaceDir === '') {
    throw new TypeError('ensureDshDir requires a workspaceDir');
  }
  const dshDir = path.join(workspaceDir, '.dsh');
  fs.mkdirSync(dshDir, { recursive: true });
  ensureSelfIgnore(dshDir);
  return dshDir;
}

/**
 * 只补 `.gitignore`，不创建目录（用于目录已存在的路径）。
 *
 * 失败**不抛错**：这是一个"锦上添花"的保护。
 * 用户的数据能写进去比"记得忽略"重要得多 ——
 * 如果因为写 .gitignore 失败而让整个 Mission 存不下来，那是本末倒置。
 *
 * @param {string} dshDir
 */
function ensureSelfIgnore(dshDir) {
  try {
    const file = path.join(dshDir, '.gitignore');
    // 已存在就不覆盖 —— 用户可能自己改过（比如加了 `!重要文件`）
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, SELF_IGNORE, 'utf8');
  } catch { /* 见上：失败不阻断数据写入 */ }
}

module.exports = {
  SELF_IGNORE,
  ensureDshDir,
  ensureSelfIgnore,
};
