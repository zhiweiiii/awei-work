import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { format } from "node:util";

const input = readline.createInterface({ input: process.stdin });
let initialize;
const initialized = new Promise((resolve) => { initialize = resolve; });
const pending = new Map();
let sequence = 0;
input.on("line", (line) => {
  try {
    const message = JSON.parse(line);
    if (initialize) { initialize(message); initialize = null; return; }
    const waiting = pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id);
    if (message.error) waiting.reject(new Error(message.error)); else waiting.resolve(message.value);
  } catch {}
});
input.on("close", () => { for (const request of pending.values()) request.reject(new Error("awei-work 已关闭连接")); pending.clear(); });
const config = await initialized;
const write = process.stdout.write.bind(process.stdout);
const send = (value) => write(config.prefix + JSON.stringify(value) + "\n");
const finish = (value) => new Promise((resolve) => write(config.prefix + JSON.stringify(value) + "\n", resolve));
const request = (method, args) => new Promise((resolve, reject) => {
  if (pending.size >= 32) { reject(new Error("同时执行的操作过多")); return; }
  const id = ++sequence;
  const message = JSON.stringify({ type: "request", id, method, args });
  if (Buffer.byteLength(message) > 262144) { reject(new Error("单次操作数据不能超过 256 KiB")); return; }
  pending.set(id, { resolve, reject });
  write(config.prefix + message + "\n");
});
let logs = 0;
const log = (...values) => { if (logs++ < 1000) send({ type: "log", message: format(...values).slice(0, 4000) }); };
console.log = log; console.info = log; console.warn = log; console.error = log;
try {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("需要 Node.js 22 或更新版本");
  const api = Object.freeze({
    username: config.username,
    password: config.password,
    log,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(Number(ms) || 0, 300000)))),
    launch: (program, args = []) => request("launch", { program, args }),
  });
  const module = await import(pathToFileURL(process.argv[2]).href);
  if (typeof module.default !== "function") throw new Error("脚本需要 export default async (awei) => { ... }");
  await module.default(api);
  if (pending.size) throw new Error("脚本结束时仍有未等待的操作，请使用 await");
  await finish({ type: "done" });
  process.exit(0);
} catch (error) {
  await finish({ type: "failed", message: String(error?.stack || error).slice(0, 8000) });
  process.exit(1);
}
