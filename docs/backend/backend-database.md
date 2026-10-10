---
title: 数据库说明
description: 当前后端主要数据表与字段说明
---

# 数据库说明

本文档只记录后端当前已经使用的主要数据表。

## 数据库

后端使用 GORM 管理数据库连接和表结构迁移。

支持的存储驱动：

- `sqlite`
- `mysql`
- `postgresql`

当前启动时执行 `AutoMigrate`，自动维护以下表：

- `users`
- `credit_logs`
- `prompts`
- `assets`
- `settings`
- `video_tasks`
- `video_generation_logs`
- `image_generation_logs`
- `canvas_image_tasks`
- `canvas_audio_tasks`
- `comfy_bridges`
- `comfy_bridge_requests`
- `canvas_projects`
- `production_projects`
- `production_workspaces`
- `production_canvas_documents`
- `canvas_document_requests`
- `project_requests`
- `production_project_budgets`
- `production_budget_applications`
- `production_budget_grants`
- `production_budget_requests`
- `user_configs`
- `storage_objects`

后续新增表时再同步补充本文档，未实际使用的规划表不提前写入。

### users

系统用户表。用户基础信息、角色、算力点余额和第三方登录标识放在该表中。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `username` | string | 用户名，唯一索引 |
| `password` | string | 密码哈希 |
| `email` | string | 邮箱 |
| `display_name` | string | 昵称 |
| `avatar_url` | string | 头像地址 |
| `role` | string | 角色：`user`、`admin` |
| `can_create_projects` | boolean | 历史创建权限列保留；不再作为创建门槛，所有 active 普通账号与管理员可创建 |
| `can_assign_projects` | boolean | 普通账号项目分派权限，默认 false；管理员有效权限为 true |
| `credits` | decimal(20,2) | 算力点余额 |
| `aff_code` | string | 用户自己的邀请码，唯一索引 |
| `aff_count` | number | 已邀请用户数量，冗余统计字段 |
| `inviter_id` | string | 邀请人用户 ID |
| `github_id` | string | GitHub 用户 ID |
| `linux_do_id` | string | Linux.do 用户 ID |
| `wechat_id` | string | 微信用户 ID |
| `status` | string | 用户状态：`active`、`ban` |
| `last_login_at` | string | 最近登录时间 |
| `extra` | json | 扩展信息，第三方资料按平台命名空间保存，如 `linuxDo` |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

### production_projects

团队业务项目，区别于用户个人 `canvas_projects`。读取只允许创建者与当前制作负责人；管理员身份不额外授予全项目读取。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 规范化后 1–80 字，无控制字符 |
| `summary` | text | 最多 500 字，允许正常换行 |
| `created_by` | string | 由服务端当前账号写入，索引 |
| `producer_id` | string | 当前有效普通账号或管理员制作组长，索引；创建缺省为当前账号 |
| `revision` | int64 | 初始 1，条件改派成功后递增 |
| `created_at` / `updated_at` | string | UTC 时间 |

创建和改派事务重新核对权限、账号与负责人状态。所有 active 普通账号与管理员可创建自己负责的项目；指定其他组长仍需分派权限。改派按 `id + revision` 条件更新。被项目引用的创建者或当前负责人不能删除；预算历史申请人、审批人、拨付操作人也不能删除。账号禁用与权限撤销由请求时服务端重新读取生效。

### production_workspaces

项目内两个工作台的身份元数据；画布正文保存在独立 `production_canvas_documents`，图片历史与资产归属另行开发。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 独立工作台主键 |
| `project_id` | string | 项目 ID，与 kind 组成唯一索引 |
| `kind` | string | `canvas` 或 `assets` |
| `created_at` | string | 创建时间 |

### project_requests

创建幂等记录，与项目和两个工作台原子写入。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `actor_id` / `request_id` | string | 当前账号与规范化 UUID 组成联合主键 |
| `payload_hash` | string | 规范化名称、说明与负责人的 SHA-256 摘要 |
| `project_id` | string | 已创建项目 ID |

同键同内容返回原项目，同键不同内容返回冲突。省略负责人和显式指定本人先规范化成同一输入，不会重复创建。SQLite 使用单连接、WAL 和 5000 ms 忙等待，限定本机短元数据事务；PostgreSQL/MySQL 的账号行按 ID 排序加锁，不把该配置当作生产多进程或 AI 容量验证。登录只定向更新登录/资料字段，避免旧快照回写项目权限。个人积分历史保留，项目预算不读写个人余额或个人流水。

### production_project_budgets

项目独立批准额度，`project_id` 主键；`approved_total` 为 int64 正整数总额（尚未申请时视为 0），`revision` 为条件更新版本，`updated_at` 为 UTC 时间。旧项目不自动获批或迁移个人余额。首次申请事务创建零额度、revision=1 的行；GET 无行时返回总额 0、revision=0，不产生写入。每次批准追加目标总额与已批准总额的差额，预算 revision 加 1；驳回不改预算。

当前只记录管理员拨付的项目额度，尚未接入模型任务预占、消费、退款；不能把总额度称作经过模型费用结算的可用余额。免费文本画布筹备不受预算批准限制。旧个人生成接口关闭，项目任务验收后才可开放模型执行。

### production_budget_applications

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` / `project_id` | string | 申请主键与所属项目 |
| `pending_project_id` | nullable string | 待审批时等于项目 ID，决定后置空；唯一索引保证每项目最多一条待审批 |
| `applicant_id` / `applicant_name` | string | 当前制作组长账号与提交时姓名快照 |
| `target_total` | int64 | 目标总额，1 至 1,000,000,000，必须高于当前批准总额 |
| `reason` | text | 去首尾空白后 1–500 字用途，拒绝异常控制字符 |
| `status` / `revision` | string / int64 | `pending` 初始版本 1；条件决定后变 `approved` 或 `rejected`，版本加 1 |
| `decided_by` / `decided_by_name` | string | 管理员账号及决定时姓名快照 |
| `decision_note` | text | 批准说明最多 500 字，可空；驳回必须 1–500 字 |
| `created_at` / `updated_at` | string | 固定纳秒精度 UTC 时间，用于稳定历史排序 |

组长申请时锁定有效账号、项目行，再检查当前组长身份、幂等记录、目标总额与待审批数量。项目创建者若已不是组长只能读取，不能申请。改派不自动批准或丢弃已有申请，管理员看到当前组长与原申请人。

GET `/api/v1/production/projects/:id/budget` 仅创建者/当前组长可读，返回总额、预算版本、`canApply`、最近 20 条申请和历史总数。POST `/budget-applications` 同范围，接收 `{targetTotal,reason,requestId}`；响应附 `applicationId` 标明本次原申请，即使幂等重放时该记录已离开最近 20 条窗口。每条申请展示当前项目名、组长名和批准总额；审批回执重放例外，返回决定当时的完整快照。

管理员 GET `/api/admin/production/budget-applications` 支持分页与 `pending/approved/rejected` 筛选；POST `/:applicationId/decision` 接收 `{decision,note,revision,requestId}`。审批仅授予预算元数据读取，不授予其他项目画布/资源访问。

### production_budget_grants

项目拨付流水：`id` 主键、`project_id` 索引、`application_id` 唯一、`amount` int64 正增量、`approved_total` 批准后总額、`actor_id` 管理员、`created_at` 时间。只有 approved 决定写入，每申请最多一笔；申请条件更新、预算 CAS、拨付和回执共同提交或回滚。无个人资金转账、收费或隐式自批。

### production_budget_requests

`actor_id + request_id` 联合主键；保存 `payload_hash`、`project_id`、`application_id`，审批另存 `decision_json` 完整不可变回执。摘要包含操作类型、项目/申请及规范化输入；同键异内容/对象/操作返回 409。同键提交返回原申请身份及项目当前预算视图，决定重放返回原回执，不重复拨付。

所有重放均先重查账号与当前权限；被禁用、改派撤权或失去管理员身份后不可用旧键绕过。审批先锁管理员账号、再锁项目行，重读申请后按 `pending + revision` 更新，与其他审批及改派使用同一项目锁。当前 SQLite 单进程验证不代表多实例生产数据库或 20 人 AI 容量。

### production_canvas_documents

项目内独立画布文档，不复用或迁移个人 `canvas_projects`。列表只返回元数据；打开接口返回完整正文。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 服务端生成的文档主键 |
| `project_id` / `workspace_id` | string | 服务端根据授权项目及其 `canvas` 工作台派生，与更新时间组成查询索引 |
| `title` | string | 去首尾空白后 1–80 字，无控制字符 |
| `content` | text | schemaVersion=1 的 JSON 快照，只包含文本/组节点、连线、视口和背景 |
| `revision` | int64 | 初始 1；按文档 ID、项目、工作台、预期版本条件保存后递增 |
| `created_by` / `updated_by` | string | 实际创建/最后保存账号，服务端写入 |
| `created_at` / `updated_at` | string | 服务端 UTC 时间 |

四接口位于 `/api/v1/production/projects/:projectId/workspaces/:kind/documents`，只支持 `kind=canvas`：GET 列表、POST 新建，`/:documentId` 的 GET 打开与 PUT 保存。每次都在同一事务重查有效账号、项目创建者/当前负责人身份、空间和文档复合归属；管理员不默认获得项目访问。写入与项目改派采用相同项目行锁，文档 CAS 不匹配返回 409，禁止静默覆盖。SQLite 的短事务仍使用已有单连接；并发验证不代表 PostgreSQL/MySQL 生产容量。

请求最大 2 MiB，最多 300 节点、600 连线，拒绝未知字段。节点 `type=text|group`，metadata 仅 `content/groupId/fontSize`；坐标在 ±1,000,000、宽高 16–10,000、字号 8–128、缩放 0.05–10，背景为 `dots|lines|blank`。节点/连线 ID 分别唯一；端点必须存在且不能自连，组引用必须指向有效组且不能循环。正文不支持媒体/模型/文件或工具执行字段。

### canvas_document_requests

文档创建及保存的幂等回执，与文档写入同事务提交；失败回滚不会留下成功回执。不存每次正文快照或实现历史版本系统。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `actor_id` / `request_id` | string | 当前账号与规范化 UUID 组成联合主键 |
| `payload_hash` | string | 操作、项目、空间、文档、标题、预期版本及规范化正文的 SHA-256 摘要 |
| `operation` | string | `create` 或 `save` |
| `project_id` / `workspace_id` / `document_id` | string | 已授权且已提交的对象归属 |
| `revision` / `updated_at` | int64 / string | 此次提交版本及时间 |

幂等重放前仍重新验证当前授权。同键不同对象、操作或内容返回 409；相同创建请求返回同一文档当前完整版本，相同保存请求返回原提交的 `{id,projectId,workspaceId,revision,updatedAt,requestId}`，不会重新写入或回传覆盖客户端正文。客户端不得用迟到回执降低本地版本；改派或禁用后原账号不能用旧请求编号绕过撤权。

### user_configs

用户级配置和同步数据表，每个用户一行。U01-C2 保留既有列和历史记录，但个人模型配置不再通过 API 返回、写入或用于渠道/工作流执行；存储配置和其他非模型数据继续使用现有字段。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | string | 用户 ID，主键 |
| `model_config` | 大文本 | 历史模型配置列；当前读取仅提取 `syncStorageConfig`、`syncWebDAVStorageConfig` 两个存储同步布尔值。历史地址、Key、传参脚本和个人工作流不回传、不执行；保存存储同步选项时只写两项白名单标志 |
| `storage_provider` | text | 用户存储配置 JSON，内部结构为 `{ "s3": {...}, "webdav": {...} }`，两类配置可保留但不能同时启用 |
| `image_history` | text | 用户图片历史同步数据 |
| `asset_data` | text | 用户素材同步数据 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

`storage_provider.s3` 保存 Endpoint、Region、Bucket、Access Key、Secret、公开域名和路径前缀；`storage_provider.webdav` 保存 WebDAV 地址、远程目录、用户名和密码/应用密码。自动同步开关不重复写入 Provider；后端下载和删除旧媒体时仍会读取已保存但已停用的 Provider。

`GET /api/v1/user-config` 返回 `storageSync: { s3: boolean, webdav: boolean }`，不返回 `modelConfig`。`POST /api/v1/user-config/storage` 接收 `{ provider: { s3?, webdav? }, storageSync?: { s3: boolean, webdav: boolean } }`；省略同步选项时保留既有标志。个人模型写入路由 `/api/v1/user-config/model` 已撤销。未主动迁移或清理历史模型 JSON，个人记录不能恢复模型接入。

### storage_objects

S3/R2 与 WebDAV 共用的媒体文件索引表，不保存画布、素材列表或生成记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 文件 ID，前端存储 key 使用 `server:<id>` |
| `provider_id` | string | 创建文件时使用的 S3/R2 或 WebDAV Provider ID |
| `bucket` | string | S3/R2 Bucket；WebDAV 为空 |
| `object_key` | string | Provider 内相对对象路径，唯一索引 |
| `public_url` | string | S3/R2 可选公开地址；WebDAV 为空并通过 `/api/files/:id/content` 读取 |
| `mime_type` | string | 媒体 MIME 类型 |
| `bytes` | number | 文件字节数 |
| `width` | number | 预留字段，当前上传链路未写入，默认 `0` |
| `height` | number | 预留字段，当前上传链路未写入，默认 `0` |
| `sha256` | string | 文件内容摘要 |
| `direct` | boolean | 是否由登录用户的浏览器直接上传至 WebDAV |
| `created_by` | string | 创建用户 ID |
| `created_at` | string | 创建时间 |
| `deleted_at` | string | 预留字段；当前删除链路直接删除索引记录 |

### prompts

提示词表。用于保存公开提示词、内置 GitHub 系统提示词、分类和预览内容。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `cover_url` | string | 封面图 |
| `prompt` | string | 提示词内容 |
| `tags` | json | 标签列表 |
| `category` | string | 分类标识 |
| `preview` | text | Markdown 展示内容，可包含文本、图片、视频链接等 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

`github_url` 仅用于接口返回，不写入数据库。

### assets

素材表。当前用于后台素材库。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `title` | string | 标题 |
| `type` | string | 素材类型：`text`、`image`、`video` 等 |
| `cover_url` | string | 封面图 |
| `tags` | json | 标签列表 |
| `category` | string | 分类标识 |
| `description` | string | 描述 |
| `content` | text | 文本或 Markdown 内容 |
| `url` | string | 图片、视频等媒体地址 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

### video_tasks

视频生成任务表。后端创建视频任务后写入该表，后台轮询器每 5 秒统一查询未完成任务并更新进度、完成地址或失败详情；前端刷新、切换页面或关闭浏览器不会影响后端继续轮询。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，本地任务 ID，优先使用上游 task ID |
| `user_id` | string | 用户 ID |
| `user_display_name` | string | 用户显示名 |
| `model` | string | 模型名称 |
| `channel_id` | string | 模型渠道 ID |
| `channel_name` | string | 模型渠道名称 |
| `source` | string | 任务来源：`video-workbench`、`canvas`、`workflow` |
| `source_id` | string | 来源内 ID，画布任务记录画布节点 ID，视频创作台为空 |
| `upstream_task_id` | string | 上游任务 ID |
| `workflow_ref` | text | 仅新工作流任务使用的渠道/条目精确引用；旧视频任务为空 |
| `upstream_video_id` | string | 上游视频 ID，例如 Agnes 的 `video_...` |
| `status` | string | 状态：`queued`、`processing`、`completed`、`failed` |
| `progress` | number | 生成进度，0-100 |
| `seconds` | string | 视频秒数 |
| `size` | string | 视频尺寸 |
| `video_url` | text | 完成后的视频临时 URL |
| `error` | text | 失败摘要 |
| `error_detail` | text | 失败详情或最近一次轮询错误详情 |
| `request_body` | text | 创建任务时的请求摘要 |
| `parameter_translation_snapshot` | text | 自定义转译视频的规则原文、变量、任务 ID 和已完成结果快照；不保存渠道密钥，不通过 JSON 响应返回 |
| `response_body` | text | 创建任务时的响应摘要 |
| `last_response` | text | 最近一次状态响应摘要 |
| `credits` | decimal(20,2) | 创建任务时预扣算力点 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `started_at` | string | 上游开始时间 |
| `completed_at` | string | 完成时间 |
| `last_polled_at` | string | 最近轮询时间 |

后台轮询器按 `status + created_at` 查询未完成任务；旧数据库中如果残留废弃列，不再参与代码查询。

### video_generation_logs

视频创作台成果历史表。该表保存用户视频生成成果卡片的完整 JSON，并用独立字段做多设备去重、软删除和查询；它不是运行态轮询表，运行态仍由 `video_tasks` 负责。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，对应前端生成记录 ID |
| `user_id` | string | 用户 ID，多用户数据隔离 |
| `task_id` | string | 后端或上游视频任务 ID |
| `video_id` | string | 上游视频 ID 或生成结果 ID |
| `status` | string | 记录状态：`生成中`、`成功`、`失败` |
| `payload_json` | text | 完整成果卡片 JSON。删除记录会清空该字段 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `deleted_at` | string | 软删除时间，空字符串表示未删除 |

删除成果记录时只软删除当前用户对应记录，并清空该行 `payload_json`；软删除记录保留 7 天用于阻止旧浏览器缓存把已删除记录恢复回来。

### image_generation_logs

生图工作台成果历史表。当前先提供后端表和接口，前端生图工作台后续再接入；字段设计和软删除策略与 `video_generation_logs` 一致。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，对应前端生成记录 ID |
| `user_id` | string | 用户 ID，多用户数据隔离 |
| `task_id` | string | 图片任务 ID，可为空 |
| `image_id` | string | 图片结果 ID、存储 key 或 URL |
| `status` | string | 记录状态 |
| `payload_json` | text | 完整成果卡片 JSON。删除记录会清空该字段 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `deleted_at` | string | 软删除时间，空字符串表示未删除 |

### canvas_image_tasks

画布图片生成任务表。只用于画布节点生成恢复，不影响生图工作台原接口。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，本地任务 ID |
| `user_id` | string | 用户 ID |
| `source` | string | 固定为 `canvas` |
| `source_id` | string | 画布来源 ID |
| `node_id` | string | 画布节点 ID |
| `model` | string | 模型名称 |
| `channel_id` | string | 模型渠道 ID |
| `workflow_ref` | text | 仅新工作流任务使用的渠道/条目精确引用；旧图片任务为空 |
| `status` | string | 状态：`queued`、`processing`、`completed`、`failed` |
| `progress` | number | 生成进度 |
| `prompt` | text | 提示词 |
| `generation_type` | string | `generation` 或 `edit` |
| `image_url` | text | 完成后图片 URL或第一张图片 URL |
| `image_urls` | JSON | 完成后全部图片 URL，第一项与 `image_url` 一致 |
| `storage_key` | string | 存储对象 key |
| `error` | text | 失败摘要 |
| `error_detail` | text | 失败详情 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `started_at` | string | 开始时间 |
| `completed_at` | string | 完成时间 |

索引：`idx_canvas_image_tasks_user_source_node (user_id, source, source_id, node_id)`

### canvas_audio_tasks

画布音频生成任务表。只用于画布节点生成恢复，不影响原 `/audio/speech` 接口。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键，本地任务 ID |
| `user_id` | string | 用户 ID |
| `source` | string | 固定为 `canvas` |
| `source_id` | string | 画布来源 ID |
| `node_id` | string | 画布节点 ID |
| `model` | string | 模型名称 |
| `channel_id` | string | 模型渠道 ID |
| `workflow_ref` | text | 仅新工作流任务使用的渠道/条目精确引用；旧音频任务为空 |
| `status` | string | 状态：`queued`、`processing`、`completed`、`failed` |
| `progress` | number | 生成进度 |
| `prompt` | text | 提示词 |
| `audio_url` | text | 完成后音频 URL |
| `storage_key` | string | 存储对象 key |
| `error` | text | 失败摘要 |
| `error_detail` | text | 失败详情 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |
| `started_at` | string | 开始时间 |
| `completed_at` | string | 完成时间 |

索引：`idx_canvas_audio_tasks_user_source_node (user_id, source, source_id, node_id)`

### comfy_bridges

ComfyUI Bridge 设备表。每台可访问一处 ComfyUI 的独立程序注册一条设备；当前工作流配置只从后台系统设置读取，不在此表重复保存。历史个人 Bridge 数据可保留，但个人注册、查询、执行与握手能力已撤销。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | Bridge ID，主键 |
| `owner_scope` | string | 当前仅使用 `system`；历史 `personal` 记录不再授权执行 |
| `owner_id` | string | 当前系统设备为 `system`；历史用户 ID 不授予个人设备能力 |
| `name` | string | 设备显示名称 |
| `token_hash` | string | 专用 Token 的 SHA-256 摘要，唯一索引；不保存明文 Token |
| `enabled` | boolean | Token 有效标记；删除设备时整行移除 |
| `last_seen_at` | datetime | 最近一次心跳时间，用于判断在线状态 |
| `capabilities_json` | 大文本 | ComfyUI 地址、工作流目录及发现的工作流 ID/标题清单 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

索引：`idx_comfy_bridges_owner (owner_scope, owner_id)`。

### comfy_bridge_requests

Bridge 持久化请求队列表。普通执行请求由服务端按设备分配，Bridge 通过短租约领取和续租；ComfyUI 媒体只回传本机结果地址等小型元数据，服务端结算关联业务任务，删除设备或超过一小时硬截止的未完成请求标记失败，Bridge 确认不再需要重传后进入十分钟清理等待期。`inspect_workflow` 检查请求的硬截止为三十秒，调用方读取结果后立即删除；服务异常中断遗留的已完成检查请求由现有后台循环在三十秒后清理。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 请求 ID，主键 |
| `bridge_id` | string | 目标 Bridge ID |
| `owner_scope` | string | 当前仅使用 `system`；历史 `personal` 记录不再授权执行 |
| `owner_id` | string | 系统或用户归属 ID |
| `task_id` | string | 对应图片、视频或音频任务 ID；检查请求为空 |
| `kind` | string | 输出用途：`image`、`video`、`audio`，或按需读取工作流的 `inspect_workflow` |
| `status` | string | `pending`、`claimed`、`succeeded`、`failed` |
| `payload_json` | 大文本 | 执行请求的工作流、字段覆盖及媒体输入，或检查请求的工作流 ID/JSON |
| `result_json` | 大文本 | Bridge 回传的本机结果地址、文件名、MIME 等小型媒体元数据，或按需检查得到的工作流 JSON、字段和拓扑 |
| `error` | text | 失败原因 |
| `claimed_at` | datetime | 领取或重新领取时间 |
| `lease_token` | string | 当前领取者的租约令牌；续租、检查点和结果回传必须匹配 |
| `lease_expires_at` | datetime | 短租约到期时间；到期的 `claimed` 请求可以重新领取 |
| `checkpoint_json` | text | Bridge 已持久化的执行检查点，包括提交中状态与 ComfyUI `prompt_id`；提交状态不明确时按失败退款处理，不重复提交 |
| `completed_at` | datetime | 完成或失败时间 |
| `cleanup_ready_at` | datetime | 普通执行请求在业务任务完成结算且 Bridge 已确认结果后写入，超过十分钟由后台循环物理删除；检查请求完成时写入，正常由调用方立即删除，服务异常中断遗留记录在三十秒后由后台循环清理 |
| `expires_at` | datetime | 普通执行请求为一小时硬截止，`inspect_workflow` 为三十秒硬截止，均不因续租延长 |
| `created_at` | datetime | 创建时间 |
| `updated_at` | datetime | 更新时间 |

索引：`idx_comfy_bridge_queue (bridge_id, status)`、`task_id`、`lease_expires_at`、`cleanup_ready_at`、`expires_at`。

### canvas_projects

画布项目表。一条画布项目对应一行，完整项目 JSON 保存在 `project_data`，包含节点、连线、聊天会话、画布设置和视口；不拆节点表。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user_id` | string | 所属用户，与 `id` 组成主键 |
| `id` | string | 画布项目 ID |
| `project_data` | text | 完整 `CanvasProject` JSON |
| `created_at` | string | 项目创建时间 |
| `updated_at` | string | 项目更新时间 |
| `deleted_at` | string | 软删除时间，空字符串表示未删除；超过 7 天由启动时和每天定时任务物理清理 |

索引：`idx_canvas_projects_user_deleted_updated (user_id, deleted_at, updated_at)`、`idx_canvas_projects_deleted_at (deleted_at)`


### settings

系统配置表。`public` 放前端可读取的公开配置，`private` 放仅后端和管理员可读取的私有配置。配置值都用 JSON。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | 主键：`public`、`private` |
| `value` | json | 配置内容 |
| `created_at` | string | 创建时间 |
| `updated_at` | string | 更新时间 |

`public.value` 常放前端展示和可公开读取的配置，例如模型列表、登录开关等。  
`private.value` 常放渠道密钥、登录密钥、后台内部开关等。
`private.value.storage.autoSyncAllAssets` 为“全部素材云端同步”开关，默认 `false`，控制前端新增媒体和生成结果的自动转存；使用现有配置 JSON 保存，不增加数据表。

当前系统设置接口会按后端结构体序列化和反序列化已知字段；数据库 JSON 中额外存在的旧字段会被忽略。

`public.value` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `modelChannel` | object | 模型渠道公开配置组 |
| `auth` | object | 公开登录配置 |

`modelChannel` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `availableModels` | string[] | 系统可用模型列表 |
| `availableWorkflows` | string[] | 对用户明确开放的系统工作流标识列表；空列表表示不开放工作流 |
| `modelCosts` | object[] | 模型算力点配置 |
| `defaultModel` | string | 默认模型 |
| `defaultImageModel` | string | 默认图片模型 |
| `defaultVideoModel` | string | 默认视频模型 |
| `defaultTextModel` | string | 默认文本模型 |
| `systemPrompt` | string | 系统提示词 |
| `channels` | object[] | 后台开放渠道的选择元数据；不含 `baseUrl`、`apiKey`、私有脚本或完整工作流 |

`modelCosts` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 模型名称 |
| `credits` | number | 图片每张、视频每秒、文本和音频每次调用预扣的算力点，最多保留两位小数；视频智能时长 `-1` 按 15 秒计算，未配置默认不扣除 |

`auth.linuxDo` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | bool | 是否开启 Linux.do 登录 |

`private.value` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `channels` | object[] | 模型渠道配置列表 |
| `promptSync` | object | GitHub 远程提示词定时同步配置 |
| `auth` | object | 私有登录配置 |

`channels` 每项字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol` | string | 协议；原模型协议保持不变，另支持 `runninghub`、`comfyui` 工作流渠道 |
| `name` | string | 渠道名称 |
| `baseUrl` | string | 渠道接口地址 |
| `apiKey` | string | 渠道密钥 |
| `models` | string[] | 渠道可用模型列表 |
| `modelCapabilities` | object | 当前渠道手动修改过的模型分类，键为模型名称，值为 `image`、`video`、`text`、`audio`；未设置的模型沿用系统识别。公开渠道只下发可用模型分类，个人渠道配置不再使用 |
| `weight` | number | 渠道权重，同一模型命中多个渠道时按权重随机 |
| `enabled` | bool | 是否启用 |
| `remark` | string | 备注 |
| `uploadApiKey` | string | RunningHub 企业级素材上传 Key，仅私有设置保存 |
| `bridgeId` | string | ComfyUI 渠道绑定的 Bridge 设备 ID |
| `comfyUrl` | string | 生成 Bridge 启动命令时使用的 ComfyUI 地址，仅在私有设置保存 |
| `workflowDir` | string | 生成 Bridge 启动命令时使用的工作流目录，仅在私有设置保存 |
| `workflows` | object[] | 工作流条目、逐条启停、字段映射及 API JSON；只在私有设置保存完整内容 |

`promptSync` 字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `enabled` | bool | 是否开启定时同步，默认开启 |
| `cron` | string | Cron 表达式，默认每天 0 点 |

`auth.linuxDo` 当前字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clientId` | string | Linux.do OAuth App Client ID |
| `clientSecret` | string | Linux.do OAuth App Client Secret，后台返回时隐藏 |

后端请求模型时，先按模型名筛选启用且包含该模型的渠道，再按 `weight` 加权随机选择一个渠道。

RunningHub/ComfyUI 不加入上述普通模型筛选：只下发已启用且已明确勾选的工作流名称、ID 和用途，公开列表为空时不开放任何工作流；不会公开密钥、Bridge Token、字段映射或完整工作流 JSON。历史 `user_configs.model_config.workflowChannels` 不再解析或执行；用户只能提交 `scope: "system"` 的后台工作流引用。

### credit_logs

用户算力点变更流水表。当前记录后台手动调整、模型调用预扣和模型调用失败返还。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 主键 |
| `user_id` | string | 关联用户 ID |
| `type` | string | 类型：`admin_adjust`、`ai_consume`、`ai_refund` |
| `amount` | decimal(20,2) | 本次变动数量，增加为正，扣减为负 |
| `balance` | decimal(20,2) | 变动后的用户算力点余额 |
| `related_id` | string | 关联业务 ID，可为空 |
| `remark` | string | 备注 |
| `extra` | json | 扩展信息 |
| `created_at` | string | 创建时间 |

`type` 当前取值：

| 值 | 说明 |
| --- | --- |
| `admin_adjust` | 后台手动调整 |
| `ai_consume` | 调用后端模型接口消费 |
| `ai_refund` | 后端模型接口调用失败返还 |
