# 开发、安全与发布

开发约定以根目录 [AWEI-WORK.md](../AWEI-WORK.md) 为准，贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。仅支持 Windows 本机工作区。

## 运行与检查

准备 Node.js 22+、pnpm、Rust stable 和 Windows Tauri 构建依赖。

~~~powershell
pnpm install --frozen-lockfile
pnpm tauri dev

pnpm lint
pnpm check-types
pnpm build:web
pnpm build
pnpm size
cd src-tauri
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
~~~

依赖/模块入口变更额外检查 `pnpm knip --include 'files,dependencies,unlisted,unresolved'` 与生产依赖审计，不机械删除内部仍调用的 exports。默认仓库不保存测试及测试依赖；必要临时验证在仓库外进行，并明确模拟与真实设备边界。

开发与正式构建使用主程序及手机内嵌页，不再构建或分发辅助 CLI。主二进制 dev/release 都叫 `awei-work`；Windows 运行中的实例会锁 exe。不要为释放构建锁无差别结束用户进程。编译缓存 `target/` 与安装包不是同一物，清理会增加下次构建时间。

## 安全边界

PTY/Git/LSP 复用工作区授权；插件权限核对 `src-tauri/capabilities/`，应用命令仍自行校验输入。文件/网络/进程操作有大小、时间和并发上限，阻塞操作不占用界面线程。

Web 手机桥接是远程 shell，必须设置个人密码，并放在可信网络/VPN 后；Claude 网关只监听回环并校验令牌。凭据、正文和输入不写诊断。设置中的供应商信息及定时消息可能含本机明文数据，备份或共享前检查；密码哈希与消息明文不能混为同一保护方式。

当前 asset scope 为 `**`，允许加载应用可访问的本地媒体，不是只读项目文件沙箱。CSP 的 img/media 只允许准确的本机 asset origin 及既有来源；不能为修预览放开任意 HTTP 图片/媒体。网页开发预览有脚本/存储权限，不应当作完整隔离不可信网站的沙箱。

不把 OSC 或文件内容当命令执行；Markdown 过滤 HTML/危险协议，链接经业务校验。公开 HTTP、跨窗口读改写、外部文件/Git 并发等已知边界见 [限制](issues.md)。

## 构建与版本

统一用仓库包装器 `pnpm tauri build`，不绕过 `scripts/tauri.mjs`。默认只生成 Windows x64 NSIS 手动安装包，不生成 MSI 或未配置签名的更新产物。

包装器对源码、配置及二进制资源生成指纹，相对上一次成功打包发生变化时自动递增 patch，同步 package.json、Cargo.toml、Cargo.lock、tauri.conf.json。失败回滚清单；`.terax-package-state.json` 为忽略的本机状态。tag 模式要求 `v<version>` 与清单一致，不再增号。

安装包位于 `src-tauri/target/release/bundle/nsis/`。NSIS 为 perMachine，首次安装可选目录，后续恢复原目录；需要提权安装不代表日常运行必须管理员权限。

安装器直接覆盖更新，不再询问是否卸载旧版；同版本重装也直接覆盖，更新不调用旧卸载程序或清理用户数据。升级前保存文件并退出旧版本，运行检测仍会提示关闭程序。系统中的正常卸载入口保留。自定义 `src-tauri/installer.nsi` 基于 Tauri CLI 2.11.4 官方模板，移除维护选择页及旧版卸载分支；升级 Tauri CLI 时需对照该版本模板同步运行检测、WebView2、快捷方式和卸载行为。

## 正式发布

1. 确认范围和验收，保存最终代码、文档及统一版本，检查 dirty 工作树。
2. 完整构建最终源码，核对程序版本、安装包大小和 SHA256；最后补的代码不能用旧包交付。
3. 提交推送并创建不可移动的版本标签；`v*` 会触发 Release 工作流，手动发布时避免并行任务覆盖已校验附件。
4. 上传 NSIS 到 draft，核对服务端摘要，公开发布为非预发布；再次公开下载并比对 SHA256。
5. 在 [issues](issues.md) 简记版本、验证边界及重要变化，详细发布历史留在 GitHub Releases，不重复保存每轮进度表。

更新器默认检查本仓库 `zhiweiiii/awei-work` 的正式 NSIS，并打开手动下载页。失败显示错误，不伪装已是最新。

项目品牌统一为 awei-work，安装包、辅助命令和源码包名同步更名。应用 bundle id、旧配置键/目录、IPC、shell 环境标识及 Explorer 注册表键保留兼容；否则已有项目、主题、定时任务和窗口记录可能无法读取。旧 `.terax-theme` 文件仍可导入，新文件使用 `.awei-work-theme`；更新检查兼容旧安装包名，不重命名已发布的历史附件。

签名自动更新须同时配置 secret `TAURI_SIGNING_PRIVATE_KEY`、variable `AWEI_WORK_UPDATER_PUBLIC_KEY`，有密码时加 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。工作流生成临时 overlay 并启用 `VITE_AWEI_WORK_SIGNED_UPDATES=true`；兼容旧公钥 variable 和前端环境变量名称。不得沿用上游公钥或 SignPath。安装前主窗口检查未保存文件/前台任务并等待工作区保存，设置窗口不能绕过。当前未完成实际签名渠道验收。

## 文档维护

文档只写当前有效行为、关键原因、限制和必要维护步骤。新增功能更新对应主题；修复在 issues 简记结果与验证范围。重复说明不在多篇复制，废弃过程日志和文件清单留给 Git 历史。不要把静态/模拟验证写成真机验收，也不作无缺陷承诺。
