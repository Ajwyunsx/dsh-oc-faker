# dsh-oc-faker — DSH 全局 User-Agent 伪装

解决「服务端 user-agent 校验」问题：某些模型网关（如 opencode 网关）只放行
`User-Agent: opencode`，而 DSH 的 LLM 层（dsh-llm `attributionHeaders()`）硬编码发送
`deepseek-harness/x (+url)` 且无法从配置改。本插件在宿主进程内全局接管出站 HTTP 的 UA 头，
一键伪装为可配置值（默认 `opencode`）。

## 覆盖范围（三层抗体，全链路无死角）

| 层 | 手段 | 覆盖 |
|---|---|---|
| fetch | 包装 `globalThis.fetch` | LLM 请求、web 搜索、网关转发、插件内 self-check 等一切 fetch 调用 |
| undici | 包装全局 dispatcher（`Symbol.for('undici.globalDispatcher.1')`） | fetch 之外的裸 undici 请求 |
| http(s) | 给 `http.globalAgent` / `https.globalAgent` 注入默认 `User-Agent` | node 原生 http.request / axios 兜底 |

## 三种伪装模式（`dev_ua_set mode=`）

- `force`（默认）— 所有主机全量替换为伪装 UA（LLM 网关场景直接可用）
- `fill` — 仅在调用方未显式设置 UA 时补上（最保守）
- `targets` — 仅对名单内主机伪装，其余主机原样放行

`keep` 名单优先级最高：名单内的主机永远保留其原始 UA。

## 工具

| 工具 | 说明 |
|---|---|
| `dev_ua_status` | 查看当前 UA / 模式 / 名单 / 补丁生效状态 / 持久化文件 |
| `dev_ua_set` | 运行时改值/模式/名单，持久化到 `~/.dsh/ua-spoof.json`，重载/重启自动恢复 |
| `dev_ua_test` | 端到端自检：本地回环 echo 证明补丁真实生效；可选 `url` 探测外部端点 |

## 使用

```bash
# 注入（本环境已常驻注入器）
dev_inject_plugin /home/dsh/dsh-oc-faker
```

```text
dev_ua_test                  # 本地回环验证：server saw UA="opencode" PASS ✓
dev_ua_set ua=opencode       # 换值（默认已是 opencode）
dev_ua_set mode=targets addTarget=opencode.go      # 只对网关伪造
dev_ua_test url=https://httpbin.org/headers        # 外部端点实况探测
```

## 卸载

```bash
dev_uninject_plugin dsh-oc-faker   # fiber 全清理，fetch/dispatcher/agent 全部还原
```

## 状态持久化

`~/.dsh/ua-spoof.json`（不存在则不落盘；改动即写，原子替换）。优先级：
默认值 < 环境变量 `DSH_UA` / `DSH_UA_MODE` < 插件 config < 持久化文件。

## 官方插件命令安装（bundle 装配）

本包是标准 DSH 插件包，支持官方 `dsh plugin` 通道安装（重启后由 profile bundles 自动装配）：

```bash
# 从本地目录（已注入/热装过的场景）
dsh plugin --profile web add /path/to/dsh-oc-faker

# 从 GitHub 仓库
dsh plugin --profile web add github:Ajwyunsx/dsh-oc-faker

# 或经注入器一步落盘为官方 bundle（免重启生效，重启后官方接管）
dev_install_package /path/to/dsh-oc-faker
```

装好后 `~/.dsh/profiles/web/package.json` 会包含：

```json
"dependencies": { "dsh-oc-faker": "link:/path/to/dsh-oc-faker" },
"dsh": { "profile": { "bundles": [ "...", "dsh-oc-faker" ] } }
```

当前环境已按此方式装配完毕，运行时由 loader entry 提供（`dev_ua_status` 可验证），重启后由 bundles 列表官方接管，无需再手动注入。

## 官方在线安装（已实测验证）

仓库已声明 `dsh.bundle.patch` 元数据（package.json + 自带的 cordis.patch.yml），
官方命令会把它自动激活为 profile 层（bundle），不是"普通依赖"：

```bash
# 任意外部 DSH 实例在线安装（实测通过，6 秒 clone 完成）
dsh plugin --profile web add github:Ajwyunsx/dsh-oc-faker
```

装完 `~/.dsh/profiles/<name>/package.json` 的 `dsh.profile.bundles` 会自动包含
`dsh-oc-faker`，重启后由官方 bundle 装配加载。更新走同一命令（`add` 或 `update`）。

> 注意：不带 `dsh.bundle` 声明的包会被 `dsh plugin` 的 reconcile 机制当作"普通依赖"
> 而非 profile 层（官方会打印 warning）。本包 v0.1.1 起已满足 bundle 声明要求。

## npm registry 安装（已发布）

包已发布到 npm：**`dsh-oc-faker` v0.1.1**（https://www.npmjs.com/package/dsh-oc-faker）

```bash
# 官方命令走 npm registry 在线安装（实测通过，bundles 自动激活）
dsh plugin --profile web add dsh-oc-faker

# 或任意 Node 项目直接引用
npm install dsh-oc-faker
pnpm add dsh-oc-faker
```

三种安装通道等价：npm registry（`dsh-oc-faker`）/ GitHub git（`github:Ajwyunsx/dsh-oc-faker`）/ 本地目录（`link:`）。包内含
`dsh.bundle.patch` 声明，`dsh plugin add` 一律自动激活为 profile 层。

## 排错：ERR_PNPM_ADDING_TO_ROOT

官方 `dsh plugin add` 会把 pnpm 透传到 profile（profile 本身是 pnpm workspace root）。
pnpm 11 会提示在 workspace root 加依赖需 `-w`。官方转发层不带 `-w`，解决方式：
在 profile 的 `pnpm-workspace.yaml` 顶层声明（已在本机 web profile 配置好）：

```yaml
ignoreWorkspaceRootCheck: true
```

之后 `dsh plugin --profile web add dsh-oc-faker` 直接可用，无需任何附加参数。
