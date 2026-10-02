# Lanmd

局域网 Markdown 双向同步工具。在一台电脑上运行服务，把一个 Markdown 目录（vault）暴露给局域网内的手机和浏览器：手机浏览、编辑、自动保存；电脑端用 VS Code / Obsidian 修改后，手机 **1.5 秒内自动刷新**。

同步机制只有两个：**版本号校验（PUT 冲突检测）+ SSE 单向广播**。没有协同编辑、没有账号系统、没有数据库——磁盘是唯一数据源。

## 下载

前往 [Releases](https://github.com/iop666/lanmd/releases) 下载 Windows x64 版本：

| 文件 | 说明 |
|---|---|
| **`lanmd-v*.exe`** | 推荐：托盘应用，免安装单文件（约 7.6 MB） |
| `lanmd-server-v*.exe` | 无托盘 CLI 版，环境变量配置，适合脚本/服务器 |

## 快速开始

1. 把 `lanmd.exe` 放到任意目录（建议单独建一个文件夹），双击运行——托盘出现图标
2. **左键单击托盘图标**：浏览器打开主页面
3. 首次使用在页面中**设置配对码**（中英文均可），设置后会展示局域网地址和二维码（二维码已含配对码，手机扫码直接连接）
4. 手机浏览器打开地址（或扫码），开始编辑

- 数据保存在 exe 同级的 `Lanmd-data/` 目录（`config.json`、`vault/` 笔记库、`logs/` 日志）；连同 exe 一起拷走即完成迁移
- **右键单击托盘图标**：打开笔记库 / 数据文件夹 / 日志、复制局域网地址、重启服务、开机自启、退出
- 电脑端 VS Code / Obsidian 直接编辑 vault 目录里的文件，所有设备实时同步

## 功能

- **实时同步**：任何一端保存，其余设备秒级刷新；同时编辑时通过版本号检测冲突，弹窗选择「用我的覆盖 / 放弃我的改动」，绝不静默覆盖
- **编辑器**：CodeMirror 6，移动端软键盘友好；Markdown 实时预览，宽屏双栏、窄屏切换
- **文件管理**：新建文件/文件夹（自动补 `.md` 后缀）、重命名、删除、搜索；长按/右键菜单
- **导入/上传**：从本机导入 `.md` 文件或整个文件夹（保留目录结构），重名以导入内容为准
- **倒计时暂存库**：6 个独立槽位（1小时×2、30分钟×2、10分钟×2），贴入内容后开始倒计时，到期自动删除；任何一端编辑都会重置倒计时
- **一键复制**：复制 Markdown 源码或渲染后的纯文本
- **自动保存**：编辑后 800ms 防抖自动保存；切后台立即保存；`Ctrl+S` 手动保存
- **暗色主题**：跟随系统；移动端适配（抽屉文件树、触控友好）

## 配置

`Lanmd-data/config.json`（首次运行自动生成）：

```json
{
  "vault": "Lanmd-data/vault",
  "port": 8787,
  "token": "配对码，空 = 待浏览器端设置",
  "ignore": [".git", ".obsidian", "node_modules", ".trash"]
}
```

- `vault` 改成你的笔记目录（如 Obsidian 库），支持中文路径
- 忘记配对码：查看 `token` 字段，或删除该字段后重启重新设置
- 环境变量覆盖（优先级更高）：`MDLIVE_VAULT`、`MDLIVE_PORT`、`MDLIVE_TOKEN`

## 从源码构建

要求 Node.js 20+（TS 版与前端）；Tauri 版另需 Rust 工具链。

```bash
npm install

# Web 前端 + Node.js 服务端（开发模式：npm run dev）
npm run build

# Node.js 版启动 / 测试
npm start
npm test            # 42 项自动化测试（HTTP 级，两套服务端共用）

# Tauri 托盘版（推荐，产物 tauri/target/release/lanmd.exe）
npm run tauri:build
```

目录结构：

```
├─ server/        # Node.js + Fastify 服务端（TypeScript）
├─ web/           # React + Vite 前端（两种服务端共用）
├─ tauri/         # Tauri v2 外壳 + Rust 服务端（axum + notify）
└─ scripts/       # 自动化测试与工具脚本
```

## 异网访问（内网穿透）

默认只在局域网内可用。跨网络访问（例如在公司连家里的笔记）需要一条隧道，推荐两种方式：

**方式一：内网穿透（如 [SakuraFrp / natfrp](https://www.natfrp.com/)）**

1. 在 natfrp 完成实名认证，创建一条 **HTTP 隧道**：本地 IP `127.0.0.1`，本地端口 `8787`
2. 启动隧道后会得到一个公网地址（如 `https://xxx.natfrp.cloud` 或带端口的域名）
3. 打开页面侧栏的「连接信息 / 配对码」，在**隧道穿透（异网访问）**中填入该地址并保存（也可直接改 `Lanmd-data/config.json` 的 `publicUrl` 字段后重启）

   二维码会立即切换为公网地址，手机在**任何网络**扫码即可连接；托盘「复制地址」同样优先复制隧道地址。

注意事项：

- 配对码是唯一防线，公网环境请使用**长且随机的口令**（服务端对连接尝试有每分钟 10 次的限速）
- 流量经由穿透服务商转发且为明文 HTTP——介意的话优先选支持 TLS 的隧道类型，或用方式二
- 经隧道接入时，所有用户共享同一条限速通道（来源 IP 相同）

**方式二：组网 VPN（更安全，推荐）**

设备都装上 [Tailscale](https://tailscale.com/)（或 ZeroTier / WireGuard），手机直接访问电脑的虚拟 IP（如 `http://100.x.x.x:8787`）。流量端到端加密、不经第三方转发、无需改任何配置，二维码照常可用。

## 安全说明

- 服务为局域网明文 HTTP，仅配对码保护——**不要暴露到公网**；跨网段使用请走 VPN（如 Tailscale）
- 笔记数据全部保存在本地，程序不访问任何第三方服务
- 局域网 http 环境下浏览器剪贴板 API 受限，复制功能已内置兼容方案

## 常见问题

**手机打不开地址？**
允许 Windows 防火墙（首次启动弹窗勾选「专用网络」），或手动放行：
`netsh advfirewall firewall add rule name="lanmd" dir=in action=allow protocol=TCP localport=8787`
并确认手机与电脑在同一网络（部分路由器开启了 AP 隔离）。

**忘了配对码？**
打开 `Lanmd-data/config.json` 查看 `token` 字段；或删除该字段重启，重新设置。

**Obsidian 库能直接用吗？**
可以，把 `vault` 指向库目录即可，`.obsidian` 默认在忽略列表。

**复制按钮没反应？**
非 https 环境部分浏览器限制剪贴板 API，程序已内置兼容方案。

## 许可证

MIT
