# 项目文档

使用介绍、下载和截图见根目录 [README](../README.md)。开发前先读 [AWEI-WORK.md](../AWEI-WORK.md)，贡献流程见 [CONTRIBUTING](../CONTRIBUTING.md)。

这里只保留单层主题指南，不另建架构/历史子目录。

- [架构与项目窗口](architecture.md)：模块入口、IPC、分组/文件归属、保存和 Git。
- [终端与输入](terminal.md)：PTY、ConPTY/Job、输入光标归属、渲染器池、WSL 与排障。
- [手机访问](mobile.md)：认证、共享会话、首屏/实时输出、对话显示和发送确认。
- [Agent 配套功能](agents.md)：Claude/Codex 历史与自动恢复、用量、定时任务和供应商网关。
- [开发、安全与发布](maintenance.md)：运行检查、权限边界、构建版本及发布流程。
- [限制与近期变更](issues.md)：当前取舍、待实机验收和近期修改。

文档只写当前有效结论，关键设计保留原因和失败边界。行为变化更新对应主题，修复简记原因、结果和验证范围；不重复追加过程日志或审查文件清单。历史在 Git 与 GitHub Releases 查阅。
