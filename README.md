# MailManager

独立的 Tauri 2 + React 桌面取件工具，只在本机保存手动导入的 Outlook OAuth 账号，通过 IMAP 或 Microsoft Graph 读取邮件并提取验证码。

## 功能

- TXT 文件与文本框手动导入账号
- IMAP / Microsoft Graph 协议单选或双选
- 批量取件：按当前页读取、可调并发、验证码正则提取
- 单邮箱取件：IMAP / Graph 服务端分页、邮件列表与正文详情弹窗
- 收件箱 / 垃圾箱切换
- 批量删除、单账号删除、清空全部（原生确认对话框）
- 导出账号（系统保存对话框，自由选择保存位置）
- 本地广告配置：店铺名称、描述、跳转链接，可随时在设置中调整或关闭
- 明暗主题与紧凑桌面布局

账号格式（`----` 分隔）：

```text
account@example.com----password----client_id----refresh_token
```

## 环境要求

### 通用工具链

| 工具 | 版本要求 | 说明 |
|------|----------|------|
| Node.js | ≥ 20.19（建议 22 LTS） | Vite 7 最低要求 Node 20.19+ / 22.12+ |
| pnpm | ≥ 10（锁定 10.13.1） | 包管理器，`packageManager` 已声明；可用 `corepack enable` 或 `npm i -g pnpm` 安装 |
| Rust | stable（1.77+，建议最新） | 通过 [rustup](https://rustup.rs) 安装 |

### 各平台系统依赖

**macOS**

- Xcode Command Line Tools：`xcode-select --install`

**Windows**

- Microsoft Visual C++ Build Tools（含 MSVC 编译器与 Windows SDK）
- WebView2 Runtime（Windows 10/11 通常已内置）
- 交叉编译需自行安装对应 target（如 `rustup target add x86_64-pc-windows-msvc`）

**Linux（Ubuntu/Debian）**

```bash
sudo apt update
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
  librsvg2-dev patchelf libssl-dev build-essential \
  libgtk-3-dev libayatana-appindicator3-dev
```

> 其他发行版依赖请参考 [Tauri 官方文档](https://v2.tauri.app/start/prerequisites/)。

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/<your-org>/MailManager.git
cd MailManager

# 2. 安装依赖
#    仓库已在 package.json 声明 pnpm.onlyBuiltDependencies，
#    pnpm 会自动允许 @tauri-apps/cli 与 esbuild 的必要构建脚本，无需手动 approve
pnpm install

# 3. 启动开发模式（自动编译 Rust 并打开应用窗口）
pnpm tauri dev
```

首次运行会编译 Rust 后端（数分钟），之后增量编译很快。

> 若使用旧版 pnpm 安装后 `tauri` 命令不可用，执行一次：
>
> ```bash
> pnpm approve-builds
> ```
>
> 勾选 `@tauri-apps/cli` 后重新 `pnpm install`。

## 开发脚本

| 命令 | 作用 |
|------|------|
| `pnpm tauri dev` | 启动桌面应用（开发模式，热更新） |
| `pnpm dev:web` | 仅启动前端 Vite 开发服务器（浏览器调试用） |
| `pnpm check` | 前端构建 + `cargo check` 全量检查 |
| `pnpm lint` | ESLint 代码检查 |
| `pnpm build:web` | 仅构建前端产物到 `dist/` |
| `pnpm build` | 构建并打包桌面应用（当前平台） |
| `pnpm build:macos` / `build:windows` / `build:linux` | 按平台打包 |

打包产物输出到 `src-tauri/target/release/bundle/`。

## 数据存储与安全

账号数据只保存在本机，**不会上传任何服务器**。

| 位置 | 内容 |
|------|------|
| `~/Library/Application Support/cfd.ccmtc.mail/`（macOS） | `accounts.enc`（AES-256-GCM 加密的账号数据）+ `accounts.salt`（Argon2id 密钥盐） |
| Windows：`%APPDATA%\cfd.ccmtc.mail\` | 同上 |
| Linux：`~/.local/share/cfd.ccmtc.mail/` | 同上 |

- 存储文件已加密，无 salt 无法解密；salt 丢失时应用会备份损坏文件并降级为全新存储，不会崩溃。
- 数据目录在应用沙箱之外，**不属于 Git 仓库**，提交代码不会泄露账号信息。
- 建议定期在「导入账号」界面导出明文备份（会弹出系统保存对话框），或将 `accounts.enc` + `accounts.salt` 一并备份。

> ⚠️ 明文导出文件包含 refresh_token，请妥善保管，勿提交到 Git 或上传网盘公开分享。

## 广告配置

顶部工具栏 ⚙️ 按钮可打开「广告设置」：

- 启用 / 关闭顶部广告
- 自定义店铺名称、广告描述、跳转链接（点击广告即用系统浏览器打开）
- 配置保存在本地 `localStorage`，无需任何广告服务器

## 自动发布

推送语义化版本标签即可触发 GitHub Actions（`.github/workflows/release.yml`）：

```bash
git tag v0.1.0
git push origin v0.1.0
```

Actions 会构建并发布：

- Linux x86_64：DEB、RPM、AppImage
- Windows x86_64：NSIS、MSI
- macOS Intel：DMG、App
- macOS Apple Silicon：DMG、App

## 常见问题

**Q：`pnpm tauri` 提示命令找不到？**
A：pnpm 10 默认拦截依赖构建脚本，执行 `pnpm approve-builds` 勾选 `@tauri-apps/cli` 后重新安装，或直接使用本仓库已配置的 `onlyBuiltDependencies`（重新 `pnpm install` 即可）。

**Q：Linux 编译报 webkit2gtk 相关错误？**
A：未安装系统依赖，按上文「Linux 系统依赖」安装后重试。

**Q：导入账号后重启还在吗？**
A：在。数据持久化于系统应用数据目录（见「数据存储与安全」），重启不丢失。

**Q：导出时没有弹出保存对话框？**
A：导出依赖 `tauri-plugin-dialog`，请使用完整桌面应用（`pnpm tauri dev`）而非纯浏览器预览。
