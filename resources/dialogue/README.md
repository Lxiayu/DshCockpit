# resources/dialogue — 发行版语料副本（M4.1d）

这里随应用打包的是对话语料的**运行时副本**；创作与编辑永远在 `content/`
（`content/shared/dialogue/base.json` + `content/characters/<项目>/dialogue/`）。
产品代码只读本目录，绝不 require `content/**`（office-ui 边界锁）。

规则：
- `base.json` 与 content 源**字节一致**，由 `office-asset-runtime.test.js` 锁定；
  改了 content 必须重新拷贝过来，测试会提醒。
- 角色覆盖层按**生效 pack id** 命名：内置包 `deepseek-default` 演的就是鲸鱼娘，
  所以鲸鱼娘项目的覆盖层以 `characters/deepseek-default.json` 发行。以后安装的
  第三方包按各自 pack id 提供同名文件。
- 主进程缺失本目录时 fail-open：只是没有气泡，其余一切照常。
