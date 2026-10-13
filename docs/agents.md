# Claude Code / Codex 配套功能

awei-work 使用用户已安装并登录的 CLI，模型权限和费用由对应服务决定。会话历史读本机记录，用量问 CLI 接口；两者不是同一数据。

## 会话历史与恢复

顶部菜单提供新对话 Claude Code/Codex，并把当前项目目录的历史合并，按最后活动时间排序。点记录通过正常提交入口执行 `claude --resume <UUID>` 或 `codex resume <UUID>`，不是只把文字插入输入栏。

Claude 从 `~/.claude/projects/<escaped cwd>/` 读取，Codex 从 `~/.codex/sessions/<年>/<月>/<日>/` 读取。Claude 目录转义可能碰撞，Codex 日期也不是项目归属；必须逐文件核对真实 cwd，不能只看路径。标题过滤环境及指令前言，无法找到真实标题就显示无标题，不猜。

每文件头部读取上限 192 KB；扫描结果缓存 2 秒/最多 32 目录，头部缓存最多 512 文件。扫描有项数、文件数、深度和时间预算，超限返回错误而非用部分结果判断唯一性。菜单只在打开时加载，回复绑定目录/环境/打开代次。目前历史只读取 Windows 用户目录，WSL 不显示本机历史。

自动恢复最近 5 个非私密项目，持久化 `lastUsedAt` 和 `lastAgentSession`。身份由对应 PTY 的 agent 运行代次、固定记录文件、UUID/cwd 核对确认，不以最新文件代替当前会话。运行后约 1 秒检查，随后每 15 秒及退出保存时检查最近项目；没有 agent 时不周期读历史。

启动只恢复每个项目上次活动面板的一个 agent。验证确切记录后等待 PTY 和提示符就绪，预算 20 秒；隐藏面板临时绑定现有渲染器，不抢焦点。项目/面板关闭、目录改变、已有任务或用户已开始输入草稿均取消。记录缺失、WSL 历史不可读或超时不会新建对话、不会重放消息。旧版本未保存 UUID，升级后先运行一次会话并正常保存。

## 用量

底栏先读缓存，再查询，面板关闭时也每 5 分钟更新。定时强制重读、手动刷新保留，在途查询合并；成功缓存 5 分钟，失败不缓存。前端保留上次值并标记失败，自动错误不连续弹通知。

- Claude：短生命周期 `claude -p "/usage"`，保留完整原文，只解析可识别的 Current session/week。不要用 transcript token 数冒充套餐百分比；引号不能省，以免 Git Bash 路径转换。
- Codex：短生命周期 `codex app-server --stdio`，initialize 后请求 `account/rateLimits/read`，不干预正在运行的 TUI，不读取或转发登录凭据；完成或超时即回收进程树。

常驻显示 `C:5h-33%(11:39) 周-50%(10/11) O:5h-...`，百分比 <75 绿、75–89 橙、≥90 红。5h 时间显示本地时分，周时间显示月日；无法确认数据/时间则 `--`，错误用 `!` 标记并在详情保留原文。Codex 按实际窗口时长匹配，不误标其他窗口。查询不发送普通编码消息，但本项目不替 CLI 或服务商承诺计费策略。

## 定时任务

支持多个单次/每日任务，按本机时区算下一次，不按固定 24 小时累加。应用必须运行，不唤醒睡眠或关机设备。

底栏定时消息按钮不显示任务蓝点提醒，点击后查看任务列表与执行状态。

- 终端：绑定 leaf，复用标准提交与去重。重启或原终端关闭后暂停，需手动绑定；已过期重新绑定会提示立即发送。
- Codex 后台：无窗口 `codex exec --skip-git-repo-check --color never -`。
- Claude 后台：无窗口 `claude -p --output-format text`。

后台模式不使用用户终端或用户指定目录，内部目录为 app-local-data 下 `scheduled-agent`；经 stdin 传消息，每次新会话，沿用本机登录与配置，不绕过权限检查。最多并行 4 个，30 分钟超时，stdout/stderr 各保留最多 16 KiB，Job Object 回收后代。取消不能撤回已到服务商的请求。

任务保存在 app-local-data 的 `schedules.json`，开发版 `schedules-dev.json`；消息是明文，不放密钥。新增、取消及状态更新串行原子保存，损坏数据不被空队列覆盖；存储失败回滚或暂停调度，同类型实例用 Windows 锁防止重复运行。

执行前先保存 running，并在执行与完成时核对触发身份。重启发现未确认完成的单次任务标记中断，不自动重发；每日任务记录中断并安排下一次。不承诺模型请求与本地磁盘之间的恰好一次事务。

## Claude 供应商网关

`gateway/` 把 Anthropic Messages 转为兼容 OpenAI Chat Completions 或转发 Anthropic。仅监听 `127.0.0.1`，开发 34267、正式 34266，有本地令牌认证；配置只保存，真正使用该网关的 shell 启动时才监听。停止等待 socket 释放后才允许重启。

供应商按 leaf 的 `/p/<providerId>` 固定，不用全局选择改道其他终端；删除供应商返回失败，不默默换到别家。pin 不持久化、不自动继承。切换先检查前台任务，保留 cwd 重启，失败恢复 pin；探针是真实小请求，可能有费用。

环境在 spawn 时注入 `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`，清除冲突的 `ANTHROPIC_MODEL`/`ANTHROPIC_API_KEY`，不敲入终端历史。模型按 opus/sonnet/haiku 路由，剥除 `[1m]`。WSL 不注入 Windows 回环网关。

转换核心 `convert.rs`、`stream.rs`、`sse.rs` 不碰 IO。SSE 处理跨 chunk UTF-8，最终只发一次 message_delta；include_usage、工具参数稳定序列化保留，上游错误/中断不补成功结束。reqwest 在 runtime 内构建/send，并主动安装 ring provider，不能依赖更新插件先初始化。

上游禁止重定向，有 64 MiB 响应、4 MiB SSE 事件及工具数量/参数预算。服务商特有头只按对应 host 加入；OpenCode Zen 的会话头使用稳定会话 ID。不增加自动故障转移、熔断或用量数据库。
