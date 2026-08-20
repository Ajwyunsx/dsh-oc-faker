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
