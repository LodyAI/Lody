# Codex Base URL 与 API Key 设置

Status: implemented
Translation: current

[English](2026-09-09-codex-custom-endpoint-authentication.md)

## 摘要

Codex 设置在新手引导和设置页提供 ChatGPT 设备登录与 Base URL + API Key 两种模式。
自定义模式使用 generated Responses API provider，并将 credential 保留在执行主机上。

## 决策

Workspace state 只保存非 secret provider metadata。renderer 通过现有加密 ACP
authentication-input exchange 传递 API Key。候选 key 在 live probe 期间只存在于 daemon
内存中，probe 成功后才写入 `provider-credentials`。store 将 credential 绑定到完整的
launch-relevant configuration。正常状态只有一个 active binding；post-probe commit window
可以同时保留当前 published config 和 desired config 的两个 binding，直到 Flock publication
决定 survivor。Lody-owned provider state 将非 secret setup revision 作为 credential
generation，因此即使 endpoint 与所有其他 launch field 相同，不同 key 也不会共享 binding。
credential file 不需要 same-binding pending/committed 状态。文件保存 canonical launch
binding 的 SHA-256 digest，而非 raw binding 及其 env；versioned envelope 还保存非 secret
workspace/config identity，使 startup recovery 能枚举旧客户端直接删除 workspace row 后留下
的 orphan。

POSIX 目录和文件使用 `0700`/`0600`；Windows 继承 Lody per-user data 目录的 ACL。所有
session spawn，包括 cold fork 和 edit-and-resend recovery，都经过 provider-neutral process
launch boundary 做 hydration。machine-local store 负责跨 store transaction 与 recovery
algorithm；小型 adapter 负责 Codex detection、binding identity、secret validation 与 env
injection。新的 machine-local provider credential 通过扩展 adapter registry 接入，不需要在
session 或 Machine RPC launch resolution 中增加 provider 分支。V2 disk codec 保持不变，
包括 legacy `apiKey` field；transaction core 处理 opaque string secret。Codex 只在 exact
binding match 时注入 key。

provider 使用 Lody-owned env key 和独立 ownership marker。marker 记录原 `model_provider`
selector，因此切回 ChatGPT 可逆，且无需把已有 `CODEX_API_KEY` 或 reserved provider 复制进
Lody state。invalid JSON 与 namespace collision 直接失败。reserved one-shot credential key
在共享 `AgentConfig` write boundary 被拒绝，而不只在 ProviderSetup parser 被拒绝。read
normalization 也丢弃含 credential 的 AgentConfig row，使通用 create/update/show 不能持久化
或显示 secret。一个大小写不敏感 predicate 统一负责 boundary、binding exclusion、
generated-env cleanup 和设置页 filtering，以符合 Windows process env 语义。

该功能要求协商得到 `codexCustomEndpointCredentials` capability。setup row 指定 expected
non-secret setup revision，并从 `awaiting-auth` 开始。显式 credential-provisioning RPC 等待
该 exact row 在目标 daemon 可见，避免异步 Flock upload 与 config lookup 竞争。RPC 还携带
renderer-confirmed launch binding 的非 secret SHA-256 digest，其中应用了本次 revision。
daemon 在请求 key 前和 staging 前再次校验当前 row，因此另一 writer 不能保留 revision 同时
把 one-shot key 引流到不同 endpoint。每次提交都会请求并替换 key，即使同一 endpoint 已有
credential；每次 submit 使用 fresh revision。daemon 在 staging 前把 revision 写入 desired
provider state，并且仅在 setup CAS 获胜时发布 revisionized config。

现有 authentication slot 与 abort signal 覆盖 setup synchronization、secret input、probe、
credential staging 和 config publication。最后一次 abort check 紧邻 Flock commit 之前；
commit 同步返回后 slot 立即变成 committed。同步 commit failure 属于 pre-commit，rollback
staged credential；只有之后的 flush failure 才是 uncertain durability。cancellation 在
boundary 前获胜，之后则 too late。远程 HTTP endpoint 被拒绝；HTTPS 与 loopback HTTP
被接受。GitHub 等 session-only env 只在 captured canonical `AgentConfig` 完成 hydration 后
加入，所以 cold 与 prepared session startup 都能把临时变量传给 child process，而不改变
machine-local credential lookup identity。

verification probe 本身不更新 shared capability cache。probe result 作为 deferred publication
交给 setup manager，只有 exact setup revision 赢得 durable `AgentConfig` publication 后，才
在同一个 per-config credential mutation sequence 中缓存。cancelled、superseded、failed 与
durability-uncertain attempt 都不发布 capability。authenticated provisioning 与 background
setup 共享同一个 deferred probe result；probe 持有一个 publication promise 以去重 cache
write，RPC response 只是普通 value，不要求对象引用相同。provider Dialog 在 submit promise
拥有 provisioning 期间保持 mounted 且不可 dismiss，避免关闭 UI 后后台工作继续。

## 失败与清理

credential-changing edit 是 replacement setup：desired config 与 in-memory key 被 probe 时，
旧 `AgentConfig` 仍保持 published。probe 后，目标 daemon 写入 two-binding commit record，发布
desired config，再剪除 old binding，然后返回 success。publication 前后 crash 都会留下 surviving
Flock state 所需的 binding。reconciliation 只在启动时从 authoritative state 运行，不在普通
live queue drain 运行。初始 snapshot 只取得 ID；每个 ID 的引用在 per-config credential
mutation sequence 内重新读取，因此并发 publication 不会被 stale startup snapshot 剪除。

post-commit flush failure 返回 uncertain durability，保留两种 binding，并让 renderer resync，
而不是报告普通 save failure。config commit 后 capability-cache publication 是 best effort；
renderer 接受 authenticated response，即使 `capabilitiesRefreshed` 为 false，该 flag 不能授权
对已 commit config 执行 failure compensation。stale 或 superseded setup 返回 conflict。自动
failure cleanup 只携带本请求的 exact revision，因此旧请求不能取消新 setup。metadata-only
edit 绕过 provisioning；replacement commit 合并最新 published name、prompt、brand 和
title-generation field，不以 stale setup snapshot 覆盖。相同 endpoint 的 key rotation 会发布
新的 credential revision；credential store 在覆盖 active key 前拒绝没有 fresh identity 的
rotation。

切回 ChatGPT 或删除 provider 时，先写 revision-independent setup cancellation，再修改 config。
durable wildcard 同时阻止 in-flight replacement 重新发布 custom provider，并拥有 machine-local
credential cleanup intent；显式加入新 setup 时，只能与 fresh setup revision 在同一个 atomic
mutation 中撤销 wildcard。因此 replica 不会看到 wildcard 已删除而 older replacement 仍是
current setup。wildcard cancellation 会替换 exact-revision marker，而 exact cancellation 不能
降级 wildcard，所以 delete 仍能 fence 另一 replica 的 stale replacement。renderer cancellation
通过单一 transactional `WorkspaceWriter` operation 复用共享 merge rule，并返回 effective
marker 用于 optimistic projection；raw cancellation row put 不受支持。

cancellation 的 optimistic projection 可能隐藏 config，因此随后的 durable delete 携带此前捕获
的 config，不能再从 cache lookup。UI 不等待 target machine。daemon durable 应用 cancellation
后 reconcile affected config ID，只有不存在引用它的 published custom config 或 custom setup
时才删除 local credential。这也覆盖 daemon 只观察到 `custom -> deleted`、未看到 intermediate
non-custom config 的情况，不需要第二种 cleanup row family。通用 CLI 删除 custom Codex
endpoint 时使用同一个 atomic wildcard-cancellation protocol。startup recovery 还会合并本地
枚举出的 credential ID 与 workspace row ID，使旧 direct-delete client 留下的 orphan 可被收集。

## 证据

### 消融审查

branch review 用现有行为测试比较了每项删除：

| 删除项                                                      | 观察结果                                                                                                     | 决策                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| staging 时的 previous credential binding                    | 两个 real-store test 失败：published endpoint 在 commit window 以及恢复到旧 config 后丢失 key。              | 保留两个 binding，直到 publication durable。                                       |
| cached RPC response object 与 `published` flag              | 只有 reference-identity assertion 失败；response field 以及唯一一次 probe/publication 均相同。               | 删除 cache，断言 response value。                                                  |
| V1 credential reader 与 V2 envelope factory                 | 七个 real-store test 与 setup recovery test 在现有 V2 writer 下全部通过。                                    | 只保留 strict V2 schema；未发布功能没有 V1 migration contract。                    |
| 重算已 resolved launch snapshot 并要求未使用 identity field | session execution、manager suite 与 CLI typecheck 通过。                                                     | 复用 snapshot，只保留 resolver 消费的三个 launch field。                           |
| authenticated save 要求 capability-cache success            | 新 renderer test 重现 durable 与 uncertain save 都被拒绝；移除条件后均通过，uncertain result 会等待 resync。 | 由 committed authentication outcome 决定 save success。                            |
| exact-case credential-key check                             | lowercase 与 mixed-case alias 穿过 AgentConfig/binding filter，但 Windows launch 将它们视为 reserved slot。  | 所有 boundary 使用一个 case-insensitive shared predicate。                         |
| same-binding key replacement                                | credential staging 后、Flock commit 前 crash 会丢失 previously published key 的唯一副本。                    | 把 setup revision 放入 provider state，让每代 credential 都有独立 launch binding。 |
| renderer cancellation row put                               | stale exact cancellation 可绕过共享 precedence，覆盖 wildcard delete barrier。                               | cancellation 只经复用 shared merge primitive 的 writer operation。                 |

没有删除 endpoint、binding、cancellation、publication-order 或 crash-recovery guarantee。V2
envelope 未变化。旧 experimental V1 file 不再读取，需要重新 provision credential。审查使用
synthetic fixture，没有向 live provider 发送 credential。本地 component onboarding test 需要
Node 22：已安装的 Node 26 向 test environment 暴露了不可用的 global `localStorage`。

### 功能覆盖

[draft specification](../../../../specs/codex-custom-endpoint-authentication.zh.md) 负责行为定义。
shared test 覆盖 endpoint policy、reversible overlay、collision rejection、malformed config、setup
revision parsing、wildcard cancellation、publication durability，以及 setup/AgentConfig boundary
对 exact 与 mixed-case one-shot secret 的拒绝。CLI test 覆盖 delayed setup visibility、forced key
rotation、deferred live probe 期间 cancellation、commit boundary、uncertain flush 下的 same-endpoint
generation rotation、synchronous commit rollback、pre/post-commit crash cut、real-store publication
uncertainty、另一 drain 后的 dual-binding recovery、two-config recovery 与 publication 并发、
wildcard cleanup replay、legacy direct-delete orphan enumeration、binding mismatch、digest-only
persistence、deferred capability publication，以及 common session launch boundary 的 credential
injection。

CLI coverage 还会在 atomic R2 merge 期间保持 R1 credential stage，拒绝 R1 publication 后再发布
R2；另一 two-replica test 在 R2 staged 时把 exact marker 升级为 wildcard，并证明 R2 不能发布。
component test 覆盖 metadata-only edit、per-attempt revision、exact failure cancellation、one-shot
payload、cancellation-first offline config deletion 及 reload、non-dismissible submission，以及
authenticated capability-cache degradation。真实 two-replica Flock test 覆盖 atomic wildcard
retraction 与 setup replacement，包括 setup-authoring failure 保留 barrier；direct writer test
证明 stale exact cancellation 会保留现有 wildcard marker。使用 bundled Codex 0.153.4 的受控
loopback relay 观察到带 configured model 与匹配 bearer credential 的 streamed
`POST /v1/responses`；relay 只记录 boolean credential match，然后按设计返回 401。
