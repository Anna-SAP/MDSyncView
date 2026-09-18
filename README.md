# MDSyncView

本地 Markdown 总览器：**发现本机所有目录中的 Markdown 文件，实时同步磁盘变更，并以现代化界面富文本渲染。**

- **实时同步** — 原生 `fs.watch`（ReadDirectoryChangesW）监听，文件增/删/改/重命名在 1 秒内推送到界面；原子替换（tmp + rename）、编辑器安全写入、目录级重命名/删除、事件缓冲溢出都会被正确处理。
- **全局接管** — 默认扫描所有本地固定磁盘（可改为指定目录），跳过系统目录、`node_modules`、`.git`、AppData 等噪音；支持中文文件名与大写 `.MD` 扩展名。
- **富文本渲染** — markdown-it 流水线：Emoji（原生 + `:shortcode:`）、内联 SVG 与 SVG 文件、图片/视频/音频、Mermaid 图表、KaTeX 公式、GitHub 告警块（`> [!NOTE]`）、`::: tip` 容器、任务列表、脚注、表格、代码高亮、`[[wiki 链接]]`、相对 `.md` 链接跳转。所有 HTML 经 DOMPurify 净化后再挂载。
- **全文搜索** — Node 内置 SQLite FTS5 trigram 索引，中文子串可检索；1–2 字查询自动降级为子串扫描；命令面板模糊匹配文件名/标题/路径。
- **本地运行** — 单个 Node 24 进程，仅绑定 `127.0.0.1`，索引持久化到 `%LOCALAPPDATA%\MDSyncView\index.db`，重启秒开；自动以 Edge/Chrome 应用窗口打开，可作为 PWA 安装。

## 运行

要求：Windows 10/11，Node.js ≥ 24（服务端直接运行 TypeScript，无需编译步骤）。

```bash
npm install
npm run build
npm start
```

或双击 `MDSyncView.cmd`。首次启动会在后台扫描整块磁盘（实测 5.7 万目录、约 2 万个 Markdown 文件、107 MB 文本约 5 分钟），界面立即可用并随扫描进度实时填充；之后启动只做增量核对（秒级）。

索引采用 FTS5 trigram（为了中文子串检索），磁盘占用约为 Markdown 文本总量的 4–5 倍。如果用户目录下有大量 AI 工具会话归档（如 `.codex`、`.grok`、`.trae`），可在「设置 → 排除的目录名」中加入它们以缩小索引。

命令行参数：

```
node server/src/index.ts [--no-open] [--port=4820] [--data=<数据目录>] [--root=<目录>]...
```

`--root` 可重复，用于限定扫描范围；不指定时扫描所有固定磁盘。也可在界面「设置」中修改根目录、排除规则与定期核对间隔。

### 系统托盘常驻

Release 包中的 `MDSyncView.exe` 是托盘宿主程序：双击后没有控制台窗口，程序以图标形式常驻右下角通知区域，并在后台启动 `MDSyncView-server.exe`，服务就绪后自动打开应用窗口。托盘菜单提供：打开界面（双击或左键图标同样有效）、在浏览器中打开、重新扫描全部根目录、打开数据目录、查看服务日志、重启服务、退出。服务异常退出时会自动重启（最多 3 次）并弹出提示；退出时通过 `/api/shutdown` 让服务优雅关闭。服务日志写在 `%LOCALAPPDATA%\MDSyncView\server.log`。

Windows 11 默认把新出现的托盘图标放进溢出区（任务栏右侧的 `^`），把它拖到任务栏即可固定显示。

托盘宿主用 Windows 自带的 .NET Framework C# 编译器构建（`tray/Program.cs`，无需安装 SDK），图标由 `npm run icon` 从代码生成（`assets/icon.ico` 与 PWA 图标）。从源码运行托盘模式：

```bash
npm run tray
```

它会编译 `dist/tray/MDSyncView.exe` 并启动，此时服务以 `node server/src/index.ts` 方式运行。

### 独立 EXE（无需安装 Node）

每次推送到 `main`/`master`，GitHub Actions（`.github/workflows/build-windows.yml`）会在 Windows 上运行类型检查与端到端测试，然后用 Node 官方的单文件可执行方案（SEA）把服务端打包为 `MDSyncView-server.exe`，编译托盘宿主 `MDSyncView.exe`，连同前端资源压缩为 `MDSyncView-win-x64.zip`，上传为构建产物并发布到 GitHub Releases（标签形如 `v0.1.0-build.12`）。解压后双击 `MDSyncView.exe` 即可，`client` 目录需与两个 EXE 放在一起。

本地生成同样的产物：

```bash
npm run build:exe
```

产物位于 `dist/release/`（约 90 MB，内含 Node 运行时）与 `dist/MDSyncView-win-x64.zip`。

开发模式（服务端热重载 + Vite HMR，前端在 http://127.0.0.1:5173）：

```bash
npm run dev
```

测试（真实启动服务、真实改动文件、断言 WebSocket 事件）：

```bash
npm test
```

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+P` / `Ctrl+K` | 快速打开 / 命令面板（`>` 命令，`?` 全文搜索） |
| `Ctrl+Shift+F` | 全文搜索 |
| `Ctrl+B` / `Ctrl+\` | 切换侧栏 / 大纲面板 |
| `Ctrl+Shift+V` | 渲染视图 / 源码视图 |
| `Ctrl+Shift+L` | 跟随最新变更（任何文件新增或修改时自动打开） |
| `Ctrl+E` / `Ctrl+Shift+R` / `Ctrl+Shift+C` | 默认程序打开 / 资源管理器中显示 / 复制路径 |
| `Ctrl+=` `Ctrl+-` `Ctrl+0` | 内容缩放 |
| `Alt+←` / `Alt+→` | 后退 / 前进 |
| `F5` | 重新读取当前文件 |
| `t` / `?` / `Esc` | 主题 / 快捷键帮助 / 关闭 |

## 架构

```
server/src
  index.ts     启动、根目录管理、核对调度、脏标记冲刷、打开浏览器
  watcher.ts   枢纽式监听：盘符根/Users/用户目录只做非递归监听，其子目录各挂一个递归句柄
  dirty.ts     事件合并（150ms 静默 / 600ms 最长持有）
  indexer.ts   "事件只是提示，stat + hash 才是真相"：读取、哈希、元数据、移动检测、子树核对
  scanner.ts   广度优先目录遍历（不跟随符号链接/联接点，排除目录不下钻）
  db.ts        node:sqlite：files 表 + FTS5 trigram + wiki 反链
  content.ts   安全读取（stat→read→stat、锁重试、BOM/UTF-16/GB18030 解码）
  hub.ts       WebSocket 广播、单调序号、重连回放环
  api.ts       HTTP 路由、/raw 路径校验、Host/Origin/自定义头校验、CSP
client/src
  store.ts     zustand 状态：快照 + 事件应用、重同步缓冲、文档状态机
  lib/markdown.ts  markdown-it 插件流水线、资源路径重写、wiki 链接
  lib/sanitize.ts  DOMPurify 策略（允许 SVG/MathML/音视频，禁止脚本与外部引用）
  components/Article.tsx  morphdom 原地补丁 + 按内容签名的滚动锚定
shared/types.ts  服务端与客户端共享的线协议类型
docs/DESIGN.md   设计评审综合文档；docs/SHOWCASE.md 渲染能力示例
```

同步流程：`fs.watch` → 脏标记合并 → `stat`（消失的路径有 150+300ms 宽限期，按批次而非逐文件等待）→ 读取并哈希 → 与索引比对（未变化 = 静默 touch，内容变化 = change，哈希相同且旧路径已不存在的新路径 = rename）→ 一个事务写入 SQLite → WebSocket 推送（带序号）→ 客户端更新内存索引；当前打开的文档重新读取并用 morphdom 原地补丁，阅读位置按块内容签名保持。

Windows 特有情况的处理：被监听目录本身被删除时系统不会发出 error 事件而是每秒数十万条以绝对路径为名的事件，监听器识别该形态后立即关闭句柄并标记根目录异常；每 30 秒的健康检查会在目录恢复时重新挂载并核对，也会通过 NTFS 文件标识发现"被整体替换"的目录。根目录不可读（外接盘拔出、权限问题）时核对会跳过删除步骤，不会误清空索引。服务端重启后，客户端检测到新的服务标识会自动重新拉取快照。

## 安全

- 仅监听 `127.0.0.1`；拒绝非本机 `Host`；所有请求校验 `Origin` 与 `Sec-Fetch-Site`（其他网页无法通过 `<img>`/`fetch` 读取本机文件或探测 API），写操作还必须带 `X-MDSV: 1` 头（强制跨站请求走预检）。
- `/raw` 只提供位于已配置根目录内、扩展名在白名单内的文件，且在 `realpath` 之后再次校验（防联接点/符号链接逃逸）。
- 渲染 HTML 全部经 DOMPurify 净化：禁止 `script`/`iframe`/`object`/`form`/`foreignObject`/SMIL 动画，SVG 内部引用只允许 `#` 片段，`style` 中的 `url()` 被剥离；页面带严格 CSP。
