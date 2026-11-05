# 动态执行代码

连接页提供 SSH 终端和动态执行代码。动态代码使用独立 UTF-8 `.mjs` 文件，需要 Node.js 22+，按当前 Windows 用户权限执行。浏览器连接已移除，不再提供 Chrome RPC、扩展、网页步骤或 OCR。

默认目录是 `%LOCALAPPDATA%\app.crynta.terax\connection-scripts\`，每个连接一个文件，也可填写项目中的 `.mjs` 完整路径。agent 可直接修改文件；每次执行创建新的 Node 进程加载当前代码，不监控文件并自动运行。界面保存比较内容哈希，文件被外部修改后需重新读取。

| 接口 | 用途 |
| --- | --- |
| `launch(exePath, args = [])` | 用完整 `.exe` 路径和独立参数数组启动本机程序，不拼 shell |
| `username` / `password` | 当前连接的用户名和本次取得的密码；凭据通过管道传递，不写入代码或命令行 |
| `log(...values)` | 更新连接执行信息，console 常用方法也接入此处 |
| `sleep(ms)` | 等待，最长5分钟 |

```js
export default async ({ launch, log }) => {
  await launch("C:/Windows/System32/notepad.exe", []);
  log("Done");
};
```

最多并行4个脚本，每个最多5分钟。停止、删除连接或退出应用会结束脚本及Node子进程；已启动的本机程序与已完成的副作用不会撤回。删除连接保留脚本文件。脚本仍可使用标准Node模块，应用不提供浏览器专用接口。

旧网页/本机程序配置保留ID、分组与凭据并兼容迁移。已存在的脚本文件不覆盖；旧网页自动生成的Chrome调用不再可用，需要用户修改代码。尚未迁移的旧网页记录转换为明确停用的脚本，原配置保存在legacyEntry元数据，不直接删除用户记录。
