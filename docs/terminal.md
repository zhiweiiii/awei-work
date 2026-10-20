# 终端与输入

关键实现：`src-tauri/src/modules/pty/`、`src/modules/terminal/lib/useTerminalSession.ts`、`rendererPool.ts`、`inputPolicy.ts`。

## PTY 与进程生命周期

每个分屏 leaf 对应一个 PTY Session，ID 单调递增、不复用。原生 Session 保存在 `PtyState`，输出通过 Tauri Channel 送桌面，并广播给手机；Rust 不另存屏幕历史。

reader 解析字节及 OSC，flusher 合并输出，waiter 等进程退出；退出通知必须排在尾部输出之后。输出缓冲限 4 MiB，慢手机有界队列不能阻塞 PTY。

Windows ConPTY 创建及 master 最终析构都经 `CONPTY_LIFECYCLE_LOCK` 串行化。每个 shell 与一次性子进程使用 Windows Job Object 回收后代，缺失有效 Job 则启动失败；不能用只杀父进程替代树级回收。

Session 固定所属空间的环境，启动、重试和重启不读取其他空间当前环境。shell 优先 PowerShell 7、Windows PowerShell、cmd；跳过微软商店零长度执行别名。`pty_open` 返回实际 `shellKind`，前端不按设置猜引用语法。

## 输入归属

`terminalInputOwner` 只选择 shell 独立输入栏、xterm 或无输入。主缓冲区提示符可由 shell 输入栏接管；前台程序由 xterm 原生处理键盘、光标、textarea 和 IME。

OSC 7 更新目录，OSC 133 标记提示符与命令，OSC 777 提示 agent 状态。agent 检测只看声明的 OSC，不从正文猜测。alternate screen 内的提示符标记不能移交焦点；inline TUI 的 prompt 也要等待前台任务检查，并核对命令代次。新命令、重启和退出作废旧检查。

不改写 xterm 私有光标/输入法接口，不在输出回调反复聚焦，不用定时强制刷新掩盖问题。历史滑块使用 xterm 的公开滚动层，alternate buffer 隐藏外层历史滑块。

桌面每个 PtySession 串行发送输入，最多一条写 IPC 在途，积压限 4 MiB/2048 条。原生写入/尺寸 claim 进入 blocking 池；关闭、退出拒绝剩余输入，错误可见。协议应答原样传输但不 claim 网格。提交回车是 CR (`\r`)，不是 LF。

shell 输入栏粘贴修改所属 leaf 草稿，不送 PTY；运行态保持原生 bracketed paste。提交拒绝保留草稿。“已发送”不等于命令执行成功。

## 渲染器池

普通槽位预算和 WebGL 上限均为 5。隐藏但忙碌的 leaf 保持活网格停靠，仅暂停绘制，继续解析输出；隐藏空闲 leaf 经过宽限期释放槽位，仍可保留缓冲区快速复用。

忙碌、运行 agent、alternate screen 或自动恢复中的网格不能淘汰或序列化。将 TUI 增量输出叠加到过期快照会破坏屏幕。所有槽位受保护时增加必要活网格，但 WebGL 仍最多 5，其余使用 DOM 渲染；内存随实际并行终端增加。

`DormantRing` 只保存完全没有槽位的 leaf 输出，上限 1 MiB，溢出丢最旧完整边界。保留槽位直接继续解析；真正丢失槽位才回放快照，不能复制第二套独立滚动状态。

## 路径与历史

传给 Windows ConPTY 的 cwd 用原生分隔符，前端 OSC cwd 统一正斜杠。路径拒绝控制字符并按实际 PowerShell/POSIX/fish/cmd 引用；PowerShell 同时处理普通及弯单引号，cmd 不支持的 `%`/`!`/引号明确拒绝。

终端仅启动本机 Shell，保留 PowerShell、cmd 和原生 Git Bash；不再探测或启动子系统发行版，也不再转换子系统路径。

命令历史在后台读取，默认使用 PSReadLine 历史。每个文件只读末尾 2 MiB，索引最多 20000 项；自定义 PSReadLine 路径不自动探测，无时间戳不伪造执行时间。

## 排障

开发者控制台可调用 `window.__teraxTerminalDiagnostics.enable()`、`snapshot()`、`disable()`。默认关闭，最多 256 个事件，仅记录输出字节数、公开光标、解析/绘制、尺寸、焦点和 composition，不记录正文或输入，也不落盘。

对比同一 leaf 的 output、parsed、render 与 mode/focus，区分数据、解析、绘制或焦点问题。真实 Windows CLI 和 IME 验收仍不可用模拟检查替代，见 [限制](issues.md)。
