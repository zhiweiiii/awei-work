# AWEI-WORK.md

awei-work 会把本文件作为工作区 agent 记忆加载。它规定项目边界与开发规则，详细设计见 [docs/README.md](docs/README.md)。

## 项目与方向

awei-work 是面向 Claude Code / Codex 的轻量、终端优先开发工作区，基于 crynta/terax-ai，保留 Apache 2.0 许可和出处。仅支持 Windows，含本机及 WSL 工作区；不构建 macOS/Linux，不重新实现 AI agent 或传统 IDE。

技术栈：Tauri 2 / Rust、React 19 / TypeScript、xterm.js、CodeMirror 6。主二进制 dev/release 均为 awei-work。为继承已安装版本的配置，bundle id 保持 app.crynta.terax，旧存储键、目录、IPC 和 shell 环境标识不作为品牌更名；不删除旧数据。包管理器只用 pnpm，绝不 npm/npx/yarn。

## 质量与约定

- 正确性覆盖边界、失败、并发和旧异步结果；不以“能跑”作为完成标准。
- 轻量是产品目标：新依赖、常驻轮询、额外缓存、重复 IPC 和重渲染必须说明必要性，未使用能力按需启动。
- 新逻辑放所属模块的纯函数/少依赖内核；App.tsx 与 IPC 命令保持协调层，不复制事实来源。
- 默认不写注释，必要时用 1–2 行解释为什么。代码与注释用英文，文档用中文。
- 任何地方不用 emoji 或 em-dash。
- 跨模块导入统一 @/...，路径兼容 Windows 分隔符、UNC 和 WSL。
- src/components/ui/ 和生成 AI Elements 原语不手改，升级通过对应生成流程。
- 保留用户未提交改动；不用破坏性 Git 重置，不无差别终止用户进程。
- 仓库不保留测试、测试配置或专用依赖；临时验证放仓库外，区分模拟与真实设备。

## 修改后检查

前端运行 pnpm lint 和 pnpm check-types；Rust 运行 cargo fmt --all -- --check 与 cargo clippy --all-targets --locked -- -D warnings。相关构建、浏览器/逻辑验证按改动补充；依赖或入口改动检查产物体积、结构引用和安全公告。

静态检查与隔离验证不代替真实 CLI、Windows IME、WSL、iOS 或安装升级验收，不声明软件没有任何 bug。

## 关键架构规则

Rust 负责文件、进程、网络、PTY、Git 和授权，webview 通过 invoke 或授权插件访问。命令注册以 src-tauri/src/lib.rs 为准，插件权限在 capabilities/，不能替代参数及路径校验。磁盘、UNC、进程等待和昂贵密码计算进入 blocking 池。

PTY Session 固定所属空间环境，ID 不复用；ConPTY 创建和最终关闭使用生命周期锁，所有子进程用 Windows Job Object 回收后代。前端按实际 shellKind 引用路径，不拼任意 shell 源码。桌面输入逐 Session 串行，有积压上限，退出拒绝剩余输入。

运行中 TUI 使用 xterm 原生光标/textarea/IME。不改私有接口，不在输出中反复聚焦，不定时强制刷新。shell 输入栏仅在提示符及前台检查确认后接管，新命令代次作废旧检查。alternate screen 不使用外层历史滚动条。

渲染器普通预算与 WebGL 上限为 5；忙碌、agent、alternate 或自动恢复网格绝不淘汰/序列化。隐藏忙碌 leaf 停靠但继续解析，必要时额外保留 DOM 网格。DormantRing 只为无槽位 leaf 保存有界输出。

useTabs 是标签事实来源，文件窗口同时按 spaceId/ownerTabId 隔离。分组展开不切换项目，菜单内拖动排序及同环境跨组迁移同步所属窗口，禁止改变 PTY 执行环境。顶部跨分组显示当前选中及运行 agent 的项目，按持久化首次打开顺序排列，首字图标无状态点；底部窗口按宽度驱逐最旧干净项，保护活动/最新/dirty，关闭前重查即时状态。

最近 5 个非私密项目可自动恢复已确认 UUID 的 Claude/Codex 会话；不猜最新记录、不重放消息，用户开始输入、目录改变、已有任务、记录缺失或超时不提交。旧记录及 WSL 限制见 agents.md。

文件保存串行、核对 mtime 与文档身份，失败保留草稿；跨进程不保证原子事务。媒体通过所属环境解析 asset 路径，不把正文作为文本读取，隐藏音视频暂停。Changes 显示目录树，合并公共父目录、压缩无分叉目录链，仓库分别隔离。文件事件绑定执行环境，溢出 rescan，监听按句柄释放。

手机共享同一 PTY，首屏向桌面取缓冲，不维护第二份 Rust 屏幕历史。对话优先读取确认绑定的 transcript，屏幕补实时选项；消息提交等待 writeAck，未知结果不自动重发，Codex bracketed paste 后 CR。手机不 claim 网格。

Web 是远程 shell，个人密码、Argon2id、轮换令牌及可信网络不可省。Claude 网关与本地 CLI 控制面只监听回环、校验令牌，凭据不进日志。Markdown/网页/文件链接校验不替代完整沙箱。

后台任务持久化原子保存，执行前记录 running；结果未知不自动重发。后台 CLI 请求可能产生费用，取消不能撤回远端请求。用量每 5 分钟查询并合并在途请求，失败不伪造 0%。

所有异步查询绑定目录、环境、请求/挂载身份；切换后首次渲染不显示旧范围，旧回复不覆盖新状态。写操作有同步门闩，副作用不依赖 React 更新器执行次数。配置单窗口串行，不宣称跨窗口事务。

## 构建与文档

统一 pnpm tauri build，由 scripts/tauri.mjs 管理成功构建指纹和 patch 增号，四份版本清单同步；tag 模式固定 v<version>。默认 Windows x64 NSIS 手动下载，未配置本仓库签名时不启用自动安装，不沿用上游公钥。

每次行为修改更新对应主题文档；修复在 issues 简记原因、结果和验证边界。不重复追加多份审查进度或全文件覆盖表，历史由 Git/Release 保存。与本文件规则冲突时以本文件为准。

- [架构与项目窗口](docs/architecture.md)
- [终端与输入](docs/terminal.md)
- [手机访问](docs/mobile.md)
- [Agent 配套功能](docs/agents.md)
- [开发、安全与发布](docs/maintenance.md)
- [限制与近期变更](docs/issues.md)
