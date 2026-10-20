# Linux 桌面构建（fork 专属）

上游 `apps/desktop` 只发布 macOS 与 Windows；`apps/desktop/packaging/README.md` 明确写着
“Linux is not a supported Desktop release target”，构建脚本、CI 和更新源也都只覆盖
`mac-arm64` / `mac-x64` / `win-x64`。

这个 fork（`catwithoutear/deepseek-harness`）只做一件事：让同一套 Electron 壳在 Linux x64 上
可以本地产出可运行的 AppImage，并在上游提供 Linux 包之前持续跟随上游更新。这里的所有改动都不改变
macOS / Windows 的构建行为。

## 与上游保持同步

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git   # 只需一次
git fetch upstream master
git rebase upstream/master          # 冲突通常只会出现在下面的补丁文件里
```

建议把 Linux 支持保持为**一个独立提交**（`feat(desktop): package an unsigned Linux AppImage`），
这样每次 rebase 只需要处理这一处差异；如果上游最终加入 Linux 目标，直接丢弃该提交即可。

同步后至少重跑一次本机构建（见下），确认上游的结构性改动没有让补丁失效。

## 前置条件

- Linux x64（已验证 Ubuntu 24.04 系，Linux Mint 22.3）
- Node.js 22.19+ 或 24，**且带开发头文件**（`include/node/node_api.h`）。
  `native/system` 会用 `process.execPath` 推导头文件目录；发行版打包的 Node、nvm 安装的 Node
  都带；只有运行时镜像（如某些应用内置的 `resources/node`）不带，会报
  `Node-API headers missing`。构建时请让 `PATH` 上的 `node` 指向带头文件的版本。
- pnpm `11.28.5`（仓库 `packageManager` 固定值）
- `tar`、`python3`、`make`、`g++`（`native/system` 与依赖的本地扩展）
- 首次构建会下载 Electron、Node、Python 与 npm 依赖（约 1 GB 级），需要可访问
  `nodejs.org`、`github.com`、npm registry
- AppImage 打包工具由 electron-builder 在构建时自动下载

## 构建

首次先装依赖：

```sh
pnpm install --frozen-lockfile
```

只产出解包目录（最快，用于验证运行时是否可用）：

```sh
pnpm --dir apps/desktop exec tsx scripts/package-target.ts linux-x64 --unsigned --dir
```

产出 AppImage：

```sh
pnpm --dir apps/desktop exec tsx scripts/package-target.ts linux-x64 --unsigned
```

或使用脚本别名：

```sh
pnpm --dir apps/desktop run package:linux:x64:unsigned
```

产物位置：

- 解包目录：`apps/desktop/.desktop-build/targets/linux-x64/unsigned-artifacts/linux-unpacked/`
- AppImage：`.../deepseek-harness-<版本>-linux-x86_64-unsigned.AppImage`
- deb：`.../deepseek-harness-<版本>-linux-amd64-unsigned.deb`

## 运行

AppImage：

```sh
chmod +x deepseek-harness-*-linux-x86_64-unsigned.AppImage
./deepseek-harness-*-linux-x86_64-unsigned.AppImage
```

AppImage 在部分发行版上需要 FUSE；没有 FUSE 时用 `--appimage-extract-and-run` 参数运行。
如果安装了 AppImageLauncher，双击可能被它接管（提示集成/移动文件）；直接执行上面的命令，
或改用 deb。

deb（Debian / Ubuntu / Mint）：

```sh
sudo apt install ./deepseek-harness-*-linux-amd64-unsigned.deb
# 或：sudo dpkg -i ./deepseek-harness-*-linux-amd64-unsigned.deb && sudo apt -f install
```

安装后应用位于 `/opt/DeepSeek Harness/`，菜单项是 “DeepSeek Harness”，
卸载用 `sudo apt remove deepseek-harness`。deb 会注册 `dsh://` 协议处理。

首次启动会在 `$DSH_HOME`（默认 `~/.dsh`）下准备 `profiles/desktop`，与已安装的 CLI `dsh`
共享会话、凭据和工作区，但可执行包与插件锁文件相互独立。

启动时应用会读取一次登录 shell 的环境（`zsh -ilc`、`bash -ilc`）。如果 shell 启动脚本很慢，
每个候选有 10 秒超时，最坏情况下首屏会晚几十秒；日志里会出现
`desktop login shell: ... failed (timeout)`，随后回退到下一个 shell。

## 已知限制

- 未签名：没有 Apple/Windows 那套签名链，也不产出更新 feed；应用内自动更新不可用，
  升级方式就是替换 AppImage 或 `apt install` 新的 deb。
- 没有强制更新策略：本地构建刻意跳过 `DSH_DESKTOP_MANDATORY_UPDATE_*`，
  不会去拉取上游的强制更新配置。
- 只验证 x64；`linux-arm64` 没有加入构建目标。
- 账号/Platform 内嵌页在 Linux 上按 `null` 平台上报（上游的 Platform 头只区分 macOS/Windows）。
- 菜单、托盘、快捷键、zenity/kdialog 目录选择等 Linux 分支上游已有代码，但没有经过发布级
  QA；遇到问题请优先在 fork 里修。
- 版本号与上游相同（例如 `0.2.1-rc.2`），靠产物名和清单里的 `dshBuildCommit` 区分。

## 相对上游的改动

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/scripts/desktop-build-paths.mjs`、`.d.mts` | 目标集合加入 `linux-x64`；平台映射返回 `linux`；新增 `desktopElectronExecutable()`，统一 Windows/macOS/Linux 的 Electron 可执行文件路径 |
| `apps/desktop/scripts/package-target.ts` | 增加 `linux-x64` 目标与 `--linux` builder 选择器；Linux 只允许 Linux x64 宿主；unsigned 构建使用本机环境；Linux 没有更新目标，跳过 release record |
| `apps/desktop/scripts/desktop-package-environment.mjs`、`.d.mts` | 新增 `localLinuxPackageEnvironment()`；Linux 支持 `.env.linux`；unsigned 的 Linux/macOS 本地构建跳过强制更新策略 |
| `apps/desktop/scripts/electron-builder-config.mjs` | Linux unsigned 构建不解析更新策略；固定 `executableName`、图标与 deb maintainer；产出 AppImage + deb |
| `apps/desktop/scripts/prepare-runtime.ts`、`prepare-dsh.ts` | 使用 `desktopElectronExecutable()`，不再假设非 Windows 一定是 `Electron.app/...` |
| `apps/desktop/scripts/prepare-cli.ts` | 非 Windows 的 `dsh` 启动脚本统一加可执行位 |
| `apps/desktop/scripts/smoke-packaged-runtime.ts` | 增加 `linux-unpacked` 资源/可执行文件路径 |
| `apps/desktop/scripts/desktop-toolchain-preflight.ts` | 平台参数接受 `linux` |
| `apps/desktop/scripts/desktop-build-version-discovery.ts` | `--build-version auto` 的远端映射支持 Linux（本地构建不触发） |
| `apps/desktop/src/main.ts`、`platform-view.ts` | Linux 的 Platform 内嵌页上报 `null`，不再伪装成 `darwin` |
| `apps/desktop/scripts/runtime-patch-policy.ts`、`patches/@deepseek-ai__libreoffice-kit@0.1.5.patch` | 只给 Desktop 运行时打补丁：asar 内的“包是否存在”探测会误报，导致 Linux 无法回退到 WASM Office 引擎 |
| `apps/desktop/package.json` | 增加 `package:linux:x64` / `:unsigned` / `:dir`；补上 deb 需要的 `homepage`、Linux 窗口关联用的 `desktopName` |
| `.github/workflows/linux-package.yml` | 手动触发，在 `ubuntu-24.04` 上产出 unsigned AppImage 和 deb |
| `.gitignore` | 忽略 `apps/desktop/.env.linux` |
