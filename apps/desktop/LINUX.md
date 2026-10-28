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

Linux 支持集中在默认分支 `linux`（一组独立补丁提交），CI 每天自动把这些提交 rebase 到
`upstream/master`，输入有变化时构建发布；本地也可按上面的命令手动同步。如果上游最终加入 Linux
目标，直接丢弃这些提交即可，`master` 保持为上游镜像。

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

窗口行为：

- 原生菜单栏默认隐藏（按 Alt 显示），避免在自定义界面之上多出一条系统菜单；
  Edit 菜单使用应用语言（中文为“编辑”），不再出现中英混排
- 关闭窗口会隐藏到系统托盘（面板需要支持 StatusNotifier / appindicator，Cinnamon、KDE、
  装了 AppIndicator 扩展的 GNOME 都可以）。
- 托盘图标提供“打开 DeepSeek Harness / 退出 DeepSeek Harness”，单击图标重新显示窗口。
- 如果面板没有 StatusNotifier 主机，托盘图标创建失败，此时关闭窗口会直接退出应用，
  不会留下一个找不到入口的后台进程。
- 托盘位图是 `resources/tray.png`，图标集是 `resources/linux-icons/`；改了源图后运行
  `pnpm --dir apps/desktop run render:linux-icons` 重新生成。

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

## 自动更新（nightly 通道）

发布构建会把更新源写进 `resources/app-update.yml`（generic provider，channel `nightly`），
应用里“检查更新…”走的就是这条 feed：

- 发布位置：GitHub Release 固定 tag `linux-nightly`（滚动覆盖），feed 文件名 `nightly-linux.yml`
- feed 同时列出 `.AppImage` 和 `.deb`，各自的 updater 读取自己那一项
- deb 安装：electron-builder 写入 `resources/package-type=deb`，electron-updater 选 `DebUpdater`，
  下载后通过 `pkexec`/`sudo` 执行 `dpkg -i` 并重启
  - 注意：Electron Linux sandbox 会让主进程带 `NoNewPrivs=1`，直接 spawn `pkexec` 会得到
    `pkexec must be setuid root`（exit 127）。本 fork 给 electron-updater 打了补丁：检测到该标志时改走
    `systemd-run --user --wait --pipe --collect`，由用户 systemd 实例重新起进程（`NoNewPrivs=0`）再执行
    `pkexec`；没有 `systemd-run` 时回退原行为
  - 因此 deb 自动安装需要 systemd 用户实例和一个图形 polkit agent（Cinnamon/KDE/GNOME 默认满足）
- AppImage 安装：`AppImageUpdater` 依赖 `APPIMAGE` 环境变量原位置换文件；通过 AppImageLauncher
  启动时该变量通常也会被设置
- 版本号：`<上游 productVersion>.<UTC 日期>.<run number>`，例如
  `0.2.1-rc.2.20261023.42`，semver 上严格递增；`latest` 通道不接受 prerelease，所以固定用
  `nightly`
- 本地构建不设置 `DSH_DESKTOP_LINUX_FEED_URL` 时不生成 `app-update.yml`，更新功能保持关闭
- 安装前桌面壳会向 Host 查询运行中的任务；Host 偶发超过 10 秒未答复时会自动用更宽的时限重试一次，
  仍失败才报 “task inspection timed out”
- 首次必须手动安装一个带 feed 的发布版（本仓库 release 里的 deb/AppImage）；更早的手工构建
  没有 `app-update.yml`，其“检查更新”不会工作。之后的应用内更新才会生效

发布构建命令（CI 里就是这么跑的）：

```sh
DSH_DESKTOP_TARGET_PLATFORM=linux DSH_DESKTOP_TARGET_ARCH=x64 \
DSH_DESKTOP_UNSIGNED=1 DSH_DESKTOP_APP_ID=com.deepseek.harness.linux \
DSH_DESKTOP_LINUX_FEED_URL=https://github.com/catwithoutear/deepseek-harness/releases/download/linux-nightly \
pnpm --dir apps/desktop exec tsx scripts/package-target.ts linux-x64 --unsigned \
  --build-version "0.2.1-rc.2.$(date -u +%Y%m%d).1"
```

## 包签名

- 签名密钥：`DeepSeek Harness Linux Builds (catwithoutear fork)`，
  指纹 `F1160134168931A19A907B397BD571A1F9DACC1B`，公钥在
  `apps/desktop/linux-signing-key.asc`（也会作为 release 资产上传）
- 私钥只存在于 GitHub Actions secret `LINUX_GPG_PRIVATE_KEY`；密钥 ID 放在仓库 variable
  `LINUX_GPG_KEY_ID`
- 每个 `.AppImage`、`.deb`、`nightly-linux.yml`、`SHA256SUMS` 都有 detached `.asc` 签名
- 手动签名：`pnpm --dir apps/desktop exec tsx scripts/sign-linux-artifacts.mjs`
- 验证：

```sh
gpg --import linux-signing-key.asc
gpg --verify SHA256SUMS.asc SHA256SUMS
gpg --verify deepseek-harness-*-linux-x86_64-unsigned.AppImage.asc deepseek-harness-*-linux-x86_64-unsigned.AppImage
sha256sum -c SHA256SUMS
```

限制：electron-updater 自身只校验 feed 里的 sha512，不校验 GPG 签名；签名用于人工/脚本验证，
以及发布链溯源的完整性证明，而不是应用内强制的安装门槛。

## 发布流程（GitHub Actions）

`.github/workflows/linux-release.yml`：

1. **每天 02:00（Asia/Shanghai）** 跑一次判定，另有手动 dispatch（`force=true` 可强制重发）
2. checkout `linux` 分支，fetch `upstream/master`；有新提交就把 Linux 补丁提交 rebase 上去并
   force-push 回 `linux`
3. 计算构建指纹 `<upstream commit> <patch digest>`（patch digest 是
   `git diff --binary upstream/master...HEAD` 的 sha1，即这一轮补丁的全部内容）：与滚动 release
   里的 `build-fingerprint.txt` 相同且未 force 时直接跳过，不构建也不发布；补丁内容任何变化都会
   触发重建，文档或 CI 改动同样算在内
4. 在 `ubuntu-24.04` 上构建 AppImage + deb，注入 feed 与 build version
5. 导入 GPG 私钥，签名全部产物
6. 删除旧的 `linux-nightly` release 并重建，先传二进制与签名，再传 feed/校验和/构建指纹

`gh` 会从 git 远程推断目标仓库，而 prepare job 里有 `upstream` 远程，所以 workflow 顶层设了
`GH_REPO: ${{ github.repository }}`，让每个 `gh release` 调用都落在本仓库。

rebase 冲突、构建失败、签名失败都会让 workflow 失败且**不发布**；此时需要人工在本地解决冲突后
重新跑。

## 已知限制

- 未做 Apple/Windows 那类平台代码签名（产物名仍带 `-unsigned`），但发布产物有 GPG 签名；
  deb 的 GPG 签名是 detached 文件，不写进包内，`apt` 不会自动校验
- 没有强制更新策略：本地构建刻意跳过 `DSH_DESKTOP_MANDATORY_UPDATE_*`，
  不会去拉取上游的强制更新配置
- 应用内更新不校验 GPG（只校验 sha512）；AppImage 更新要求以 AppImage 方式启动；
  deb 更新需要 `pkexec`/`sudo` 授权对话框
- 更新是“滚动 nightly”：旧版本资产会被覆盖，不做多版本并存
- 只验证 x64；`linux-arm64` 没有加入构建目标。
- 账号/Platform 内嵌页在 Linux 上按 `null` 平台上报（上游的 Platform 头只区分 macOS/Windows）。
- 菜单、快捷键、zenity/kdialog 目录选择等 Linux 分支上游已有代码，但没有经过发布级 QA；
  遇到问题请优先在 fork 里修。托盘是本 fork 新加的，只验证了 Cinnamon 系面板。
- 版本号是“上游 productVersion + UTC 日期 + run number”（见上），不是上游版本号本身；产物清单里的
  `dshBuildCommit` 只用于溯源。

## 相对上游的改动

| 文件 | 改动 |
| --- | --- |
| `apps/desktop/scripts/desktop-build-paths.mjs`、`.d.mts` | 目标集合加入 `linux-x64`；平台映射返回 `linux`；新增 `desktopElectronExecutable()`，统一 Windows/macOS/Linux 的 Electron 可执行文件路径 |
| `apps/desktop/scripts/package-target.ts` | 增加 `linux-x64` 目标与 `--linux` builder 选择器；Linux 只允许 Linux x64 宿主；unsigned 构建使用本机环境；Linux 没有更新目标，跳过 release record |
| `apps/desktop/scripts/upload-target.ts`、`desktop-edgeone.ts` | 上传与固定安装器清理路径收窄到 `DesktopAutoUpdateTarget`：fork 把 `DesktopPackageTargetName` 扩到 `linux-x64` 后，COS 上传、release 记录和 EdgeOne purge 仍只覆盖 macOS/Windows |
| `apps/desktop/scripts/desktop-package-environment.mjs`、`.d.mts` | 新增 `localLinuxPackageEnvironment()`；Linux 支持 `.env.linux`；unsigned 的 Linux/macOS 本地构建跳过强制更新策略 |
| `apps/desktop/scripts/electron-builder-config.mjs` | Linux unsigned 构建不解析更新策略；固定 `executableName`、标准 hicolor 图标目录与 deb maintainer；产出 AppImage + deb；为 Linux 附带 `tray.png`；设置 `DSH_DESKTOP_LINUX_FEED_URL` 时生成 generic 更新源与 `nightly-linux.yml` |
| `apps/desktop/scripts/prepare-runtime.ts`、`prepare-dsh.ts` | 使用 `desktopElectronExecutable()`，不再假设非 Windows 一定是 `Electron.app/...` |
| `apps/desktop/scripts/prepare-cli.ts` | 非 Windows 的 `dsh` 启动脚本统一加可执行位 |
| `apps/desktop/resources/linux-icons/`、`resources/tray.png`、`scripts/render-linux-icons.ts` | 标准尺寸 hicolor 图标与托盘位图，以及可重复生成它们的脚本 |
| `apps/desktop/scripts/smoke-packaged-runtime.ts` | 增加 `linux-unpacked` 资源/可执行文件路径 |
| `apps/desktop/scripts/desktop-toolchain-preflight.ts` | 平台参数接受 `linux` |
| `apps/desktop/scripts/desktop-build-version-discovery.ts` | `--build-version auto` 的远端映射支持 Linux（本地构建不触发） |
| `apps/desktop/src/main.ts`、`platform-view.ts` | Linux 的 Platform 内嵌页上报 `null`，不再伪装成 `darwin`；设置 Linux 窗口图标；Linux 托盘与“无托盘时关闭即退出” |
| `apps/desktop/scripts/runtime-patch-policy.ts`、`patches/@deepseek-ai__libreoffice-kit@0.1.5.patch` | 只给 Desktop 运行时打补丁：asar 内的“包是否存在”探测会误报，导致 Linux 无法回退到 WASM Office 引擎 |
| `pnpm-workspace.yaml`、`patches/electron-updater@6.8.9.patch` | 给桌面壳的 electron-updater 打工作区补丁：deb 安装时绕开 Electron 的 `no_new_privs`，否则 pkexec 必然 exit 127 |
| `apps/desktop/tests/prepare-runtime-patches.spec.ts` | 随工作区补丁数量更新断言，并把解析根 lockfile 的用例超时放宽到 30 s |
| `apps/desktop/package.json` | 增加 `package:linux:x64` / `:unsigned` / `:dir`、`render:linux-icons`；补上 deb 需要的 `homepage`，以及无空格的 `desktopName`（WM_CLASS 与 .desktop 对齐） |
| `.github/workflows/linux-package.yml` | 手动触发，在 `ubuntu-24.04` 上产出 unsigned AppImage 和 deb（不发布） |
| `.github/workflows/linux-release.yml` | 每天追踪上游 → rebase → 构建 → 签名 → 滚动发布 `linux-nightly` |
| `apps/desktop/scripts/sign-linux-artifacts.mjs` | 给 AppImage/deb/feed/SHA256SUMS 生成并校验 detached GPG 签名 |
| `apps/desktop/linux-signing-key.asc` | Linux 包签名公钥（私钥在 Actions secret） |
| `.gitignore` | 忽略 `apps/desktop/.env.linux` |
