# 参与贡献

awei-work 是一个方向明确、由个人维护的分支项目。欢迎贡献，但**方向一致比数量重要**。

这份文档帮你判断**要不要**贡献、以及**怎么**贡献才容易被合并，省下双方的时间。

## 这个项目怎么运作

- 评审带宽有限。
- 不是每个贡献都能被接受，哪怕技术上是对的。方向一致和代码质量同等重要。
- 范围和开发规则见 [AWEI-WORK.md](AWEI-WORK.md)。开任何非琐碎的东西之前先读它。
- 上游是 [crynta/terax-ai](https://github.com/crynta/terax-ai)。如果你的改动对上游也成立，优先提给上游。

个人项目就是这样，PR 被拒不是针对人。

## 快速开始

```bash
pnpm install
pnpm tauri dev
```

前置：Rust（stable）、Node 20+、pnpm，以及 [Tauri 的 Windows 前置条件](https://tauri.app/start/prerequisites/)。

开发直接运行 `pnpm tauri dev`，不再提供后台热部署脚本。

架构和"怎么安全地改"见 [AWEI-WORK.md](AWEI-WORK.md) 与 [docs/ 索引](docs/README.md)。

## 什么样的贡献容易合并

- **bug 修复**，带清晰的复现步骤。
- **文档、错别字、小的体验修正** - 直接开 PR。
- **事先讨论过的功能** - 先在 issue 里对齐。
- **小而聚焦的改动** - 好评审、风险低。

改动小而明显（错别字、窄范围的 bug 修复、小的文档改动）就直接开 PR，不需要先开 issue。

## 保持改动聚焦

**只改达成你所述目标必需的东西。**

在修 `terminal.tsx` 的一个 bug 时，不要顺手：

- 重排其它文件的格式
- 清理无关代码
- 修你本来不需要碰的文件里的 lint 问题
- 把多个不相关的修复塞进一个 PR

哪怕这些改动本身是"改进"，它们也会让评审变难、让一切变慢。想清理就在讨论之后单独开一个 PR。

**一个 PR = 一件逻辑上的事。** 混合关注点的 PR 会被要求拆开。

## 较大的改动必须先讨论

小修之外的任何东西，**开 PR 之前必须先讨论**，包括：

- 新功能
- UI/UX 改动，或改变默认行为
- 重构或"清理"
- 性能重写
- 架构改动
- 触及很多文件或系统的东西

带有大量未经请求的改动的 PR 会被直接关闭而不做详细评审。这不是要打击贡献，而是要在大量工作投入之前先对齐。

十分钟的对话能省下一个不符合路线图的五百行 PR。

## 质量线

awei-work 把自己定位为**轻量、快、生产级**。每个 PR 都按这些条目评审：

- `pnpm lint` 干净
- `pnpm check-types` 干净
- `cargo clippy --all-targets --locked -- -D warnings` 干净
- 推之前跑过 `cargo fmt`
- 已知热路径没有性能回退：终端渲染器、PTY 流、版本管理、文件资源管理器
- 没有无理由引入的重依赖（客户端 bundle 超过 50KB gzip，或 Rust 侧编译后超过 5MB）
- **只做 Windows**：平台范围限定 Windows 本机。没有明确决定不要重新引入 macOS / Linux 分支。
- 改动文件系统访问、网络路径（**包括 web 终端桥接**）、IPC 命令的，要做安全评审

**任何地方都不要用 em-dash**：代码、注释、提交信息、文档。

## 核心子系统靠手工验证

**没有自动化测试套件**（已移除），核心子系统靠仔细的手工验证和代码评审。

PR 搞坏 awei-work 最常见的方式是**局部修复，全局波及**：diff 解决了上报的那一个案例，读起来没问题，type-check 和 clippy 都过，然后静默地在同一个子系统的其它所有情况下坏掉。光靠评审不一定能抓住。

改动触及下面这些承重路径的行为时，开 PR 之前手工验证边界情况：

- **shell / 终端启动**：启动的是哪个 shell、用什么 cwd、env 和登录参数。这里的一次"修复"可以让终端完全起不来。
- **工作区授权**：允许在哪些目录里启动和跑 git。放行侧和拒绝侧都要试。
- **git 命令层**：仓库根解析、pathspec 与参数守卫、status 解析。
- **文件系统写入**：原子写、符号链接处理、部分失败时不丢数据。
- **IPC 命令面**：webview 能 invoke 的一切。
- **影响面宽的纯逻辑**：cwd 继承、标签/分屏树变换、OSC 与提示符解析、文件跨命令行的归属。
- **web 终端桥接**：attach / detach、输出流、认证，以及手机上的实际表现。

要试的是真会坏的那个案例：边界、拒绝路径、"在 home 上一层会怎样"。想不出怎么验证就先问，别直接开 PR。

## 这个项目不做什么

- 终端优先，不是 IDE 的克隆。LSP、格式化、版本管理、预览这类聚焦能力，只要保持快、惰性、资源有界，就是欢迎的。
- 不做：Jupyter 式工作区、集成的调试器与性能剖析套件、包管理器 UI、完整的网页浏览器、无界的后台索引、IDE 规模的扩展宿主。
- 不做 AI 面板。BYOK / 本地模型的 agent 系统已经从代码库移除，只保留终端侧基于 OSC 的编码 agent 检测。
- 这不是一个精心策划的"第一次开源贡献"项目。新手欢迎，但评审标准照常。
- 机械式重构、大范围风格改动、顺手重写，没有帮助。
- 欢迎 AI 辅助的贡献，但 PR 必须体现出对既有模式的理解。作者自己没读过的低成本 AI 生成代码会被关闭。

## 分支

从 `main` 开分支，用这些前缀（kebab-case）：

| 前缀 | 用于 |
| --- | --- |
| `feat/` | 新功能 |
| `fix/` | bug 修复 |
| `chore/` | 重构、工具、配置、依赖 |
| `docs/` | 只改文档 |
| `perf/` | 性能 |
| `security/` | 安全修复或加固 |

例：`feat/split-panes`、`fix/explorer-focus`、`security/path-guard`。

不要从你 fork 的 `main` 分支开 PR，在功能分支上做。

## 提交与 PR

**PR 标题会成为 squash 提交信息**。标题必须遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(terminal): add split panes
fix(explorer): prevent input from disappearing on create
chore(deps): bump tauri to 2.x
security(web): rotate session token on password change
```

类型：`feat`、`fix`、`chore`、`docs`、`perf`、`refactor`、`build`、`ci`、`security`。

常用 scope：`terminal`、`editor`、`explorer`、`pty`、`web`、`transcript`、`settings`、`tabs`、`shortcuts`、`ui`、`git`、`preview`、`lsp`、`windows`。

PR 内部各个提交的信息可以自由发挥（会被 squash 或分组）。

**填 PR 模板**：改了什么、为什么、怎么验证的。UI 改动要有截图或录屏。"手工测试步骤是……"是最低要求。

想在做的过程中要反馈就**早点开 draft PR**，做完再标 Ready for review。

### 合得快的

- 问题陈述清楚
- diff 小而聚焦
- 遵循既有模式（写之前先读两三个邻近文件）
- type-check / lint 全过
- 手工测试记录写清楚你走过的步骤

### 会被打回的

- 混合关注点的 PR
- 没有事先讨论的大型架构 PR
- 没有理由的新依赖
- 没有迁移说明的破坏性改动
- 与本次改动无关的顺带格式化
- 明显没被作者读过的 AI 生成代码

## 代码风格

- 遵循既有模式。加新文件之前先读两三个相邻文件。
- TypeScript：不用 `any`，除非你真的是那个意思。strict 模式开着。
- Rust：`cargo fmt` + `clippy` 干净。
- **注释默认不写**，代码要能自己说清楚。确实需要时只解释**为什么**，不解释**是什么**。不写多段式 docstring。
- **代码与注释一律英文**（文档是中文，这是明确接受的中英混排）。
- 代码和提交信息里不用 emoji。
- 不用 em-dash。

## 项目结构

```
src-tauri/                  Rust 后端
  src/
    lib.rs                  Tauri 命令注册
    modules/
      fs/                   文件系统命令（读写、搜索、grep）
      git/                  版本管理命令
      history/              shell 历史集成
      lsp/                  语言服务器进程宿主
      proc/                 进程工具与 Windows Job Object
      pty/                  终端会话、shell 集成、DA 过滤器、agent 检测
      secret.rs             Windows DPAPI 加解密
      shell/                一次性 / 会话 / 后台 shell 命令
      transcript/           读取 agent 自己的对话记录（Claude JSONL、opencode SQLite）
      web/                  内嵌 HTTP + WebSocket 桥接与认证
      workspace.rs          本机路径与工作区授权表

src/                        React 前端
  app/App.tsx               顶层协调者
  components/               shadcn/ui 原语
  lib/                      跨模块工具与 native 绑定
  settings/                 设置窗口
  web/                      手机页面（独立 vite 构建，内联进二进制）
  modules/
    command-palette/        命令面板
    editor/                 CodeMirror 栈
    events/                 跨模块事件总线
    explorer/               文件树
    git-history/            提交图与历史面板
    header/                 顶栏、搜索、窗口控件
    lsp/                    可选的语言服务器支持
    markdown/               Markdown 预览渲染器
    preview/                开发服务器与网页预览
    settings/               设置 UI 与偏好 store
    shortcuts/              快捷键注册表
    sidebar/                活动栏与侧面板
    source-control/         版本管理面板
    spaces/                 工作区空间，按空间持久化标签
    statusbar/              底栏、cwd 面包屑、web 状态、agent 环境面板
    tabs/                   标签与分屏模型
    terminal/               xterm.js 会话、OSC 处理、渲染器池
    theme/                  自研主题引擎与预设
    updater/                本仓库手动/签名更新 UI
    workspace/              本机工作区参数
```

## 常见问题

**修个错别字或明显的 bug 要先问吗？**
不用，直接开 PR。

**我有个新功能的想法。**
先开 issue 讨论，不要直接开 PR。

**我的 PR 被关了，也没有详细反馈。**
通常意味着它和项目方向不一致，或者范围大到无法负责任地评审。缩小范围后欢迎重开。

**我能做某个开着的 issue 吗？**
先留言确认它还相关、且没有别人在做。非琐碎的东西，实现之前先讨论方案。

**做修复的时候我看到别处可以写得更干净。**
专注在你陈述的目标上。如果那件事确实要紧，讨论之后单开一个 PR。

**评审要多久？**
看情况。小 bug 修复或文档通常几天内；较大的功能可能一两周。事先讨论过的推进更快。

**main 动了之后我的 PR 冲突了，要 rebase 吗？**
改动还相关且规模合理的话，要。大而陈旧的 PR 会被关闭，rebase 之后欢迎重开。

## 安全问题

不要作为公开 issue 提交。见 [SECURITY.md](SECURITY.md)。

## 许可

贡献即表示你同意你的工作以 [Apache-2.0](LICENSE) 授权。不需要 CLA。
