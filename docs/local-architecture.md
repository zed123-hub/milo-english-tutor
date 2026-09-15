# 本地个人导师架构

## 入口与数据

默认运行本机 Node HTTP + Vite React，SQLite 使用 Node 内置 `node:sqlite`。`LearningData` 没有 userId。`LearningRepository` 提供 read、commit、seen、replace、recovery，教学规则不直接依赖 SQL。早期托管代码不进入本机前端入口。

SQLite 保存完整学习文档、revision、epoch。commandId 去重；revision + epoch 条件提交。导入以一个事务保留恢复点、替换数据、递增 revision 并切换 epoch。只有一个恢复点，下一次导入或恢复会更新它。

## 对话与课后分析

对话角色只生成英语话语、屏幕字幕、提示程度和公开教学意图。分析角色在会话关闭后逐条观察学生原话；后台模型网络请求不占据对话写入队列，结果进入短事务时重新读取最新数据、校验 epoch，并合并到原会话。较早会话的分析不能改写较新会话的教学安排。

分析任务保存会话 ID、目标 turnIds、cursor、status、attempts、内部错误码及更新时间。queued → running → complete；缺 Key 为 waiting，接口失败为 failed。每完成一条保存一次 cursor。进程重启把 running 恢复为 queued；补充 Key 后继续 waiting；失败任务由用户主动重试。关闭服务取消分析请求。导入后的旧请求因 epoch 改变而被丢弃。

普通语音：听写/VAD → 保存原话 → 对话模型 → 英文 TTS/系统朗读 → 继续听。OpenAI Realtime 通过 WebRTC 连接，后端进行 SDP 协商；Qwen3.5 / GLM Realtime 通过本机 WebSocket 代理，专用适配器生成服务商会话格式并统一音频、转写和工具事件。record_hint 保存帮助程度，checkpoint 只保存公开意图，end_conversation 在学生明确结束时关闭。checkpoint 只排队保存公开意图，立即返回，不等待学生转写或分析模型。

GLM 等待 `session.created` 后提交初始配置；后续刷新继续携带完整的音频、VAD、工具和模型配置，并关闭 greeting。更新请求合并排队，主动请求回应等待 `session.updated` 确认。适配器保留最近 64 个回答的终态，使完成事件之后到达的工具参数仍可交付，且不会重放已交付或已取消的调用。GLM 的 checkpoint 显式要求 focus/reason，结束工具要求 reason，避免空参数对象或空 required 的兼容问题。

GLM 使用 `client_vad`，`local/glm-input.ts` 在本机按 PCM 能量判断开口和停顿；连续约 200 ms 有声后发开始事件，保留有限前置帧，约 1.2 秒静音后按 append → commit → response.create 提交。每段至多约 28 秒；仍在说话时只分段提交，等停顿后才请求回答。暂停只提交尚未结束的一句以便转写，不生成新回答。服务端 committed 返回的 item_id 与本机语音 ID 绑定，提前到达的转写短暂排队，保留原先的提示程度与计时关联。所有声音缓存仅在内存中且关闭连接时清空。这是能量检测，不是发音诊断或经过实测认证的语音识别。

本机转发将音频和控制事件分开限流：音频预算最多 10 秒，按实时时间补充，每包至少消耗 50 ms 预算，暂停后收到的包同样受限；控制事件最多突发 30 条，每秒补充 10 条。单包音频仍不超过 250 ms。`local/realtime-output.ts` 保持发往上游的事件顺序；上游发送缓冲达到 64 KiB 后暂存，全部待发送字节与上游缓冲之和不超过 1 MiB，最早等待事件超过 10 秒即中止并报告积压。短暂拥堵不会直接误报协议错误；连接关闭清空队列和定时器。

Realtime 在 speech_started 绑定提示，在 speech_stopped 截止时长；保存语音事件的发生时间，服务端校验会话时间范围后排序，避免迟到转写改变师生先后。只处理最终转写和已完成响应的工具；同批工具顺序执行后只发一次继续响应。暂停立即停止媒体，给尚未返回的最终转写最多约 1.8 秒，随后只关闭本实例所属的会话；本机保存等待也有上限，不能确认写入时明确提示。未收到最终转写的声音无法凭空恢复。

后台分析可能提高 revision，客户端遇到冲突只在同 epoch、同会话下使用原 commandId 重试一次。导入/恢复不使用这个重试，旧语音实例也不能重试到新会话。

## 证据与教学规则

画像必须有目标学生原话引用；独立/辅助表达必须实际出现在该条语音转写。提示后输出和紧接完整示范的复述不计为独立。听过示范必须关联已完整播放的老师转写。短语去重使用统一规范化方式；未知场景归为日常，不能用同义场景名制造迁移成果。

分析的理解判断只描述能否接住当次交流，不是发音能力。纠错必须引用学生原话。听过示范、辅助使用、独立使用、跨日使用和跨场景使用分开统计；学习日目前按 UTC 聚合。所有原话保留供核查，模型判断仍可能有误。

教学引擎将熟悉内容和少量新内容组合为下一次交流约束。跨会话、跨日的多种独立表达，关联实际英语证据且接住交流，才允许小幅提高一个维度；反复需要帮助时减少句子负担。观察处理时间与学生说话时间分别保存，迟到的课后分析也能参与后续调整。口头难度反馈保存在当前会话中，不直接修改长期判断。最近的长、连贯、自主英文回答可立即校准当前交流难度，排除提示、跟读、中文和旧文字资料；这条即时规则不写入能力证据或长期进阶计数。实时提示明确要求无需等待转写就跟上听到的表达水平。

复现间隔依据学生实际使用日期；单纯听老师示范不会推迟已经到期的复习。引擎提供到期表达、近期纠错和生活情境建议，由对话模型自然组织语言。规则不是经实证验证的能力等级测量。

## 迁移格式

Envelope：`format: milo-learning-backup`、`formatVersion: 1`、`dataSchemaVersion: 4`、`exportedAt`、`checksum`、`data`。校验值为 `JSON.stringify(data)` 的 UTF-8 SHA-256，仅用于发现损坏，不是加密或身份签名。

data 包含 sessions、turns、facts、evidence、memories、plan、analyses、activeSessionId、hint、createdAt、legacy。schema 3 导入时保留原始记录，补充保守难度和空分析任务，再为已关闭会话的未评估表达补建任务。V2 文字资料仅作为历史档案保留。

导入按白名单重建，检查大小、数值、枚举、唯一性、原话、引用关系、分析进度和秘密字段。拒绝不兼容版本及异常数据。关闭来自原设备的活动会话，以新会话继续。Key、账号权限、浏览器媒体对象和原始录音不属于迁移资料。

单包上限 20 MB；超限明确拒绝导出，保留完整数据库。整文档 SQLite 存储适合本机个人数据量，不能宣称无限扩展。

## 安全与字幕

只绑定 127.0.0.1；API 检查 Host/端口、同源 Origin、Sec-Fetch-Site、X-Milo-Local。拒绝请求不返回 snapshot。Key 只在后端内存中保存；偏好白名单不包含秘密。各模型角色按服务商和地址隔离 Key；仅明确匹配的接口允许共用，原始上游错误不回显。Realtime 会话票据有效 15 秒、仅使用一次，绑定同源 Origin、会话、epoch 与设置版本。代理限制消息类型、帧大小、频率和积压；浏览器只能请求刷新，不能替换服务器教学提示。切换设置、导入、结束及关闭服务时释放连接。

`GET /api/local/realtime/status` 使用同样的本机访问检查，返回 `realtime`（最后一次 WebSocket 连接的内存诊断）和 `providers`（每个服务商最近一次持久化诊断）。固定 schema 只保留状态、计数、协议里程碑和白名单错误；OpenAI 使用 RTP packet/byte，WebSocket 使用 PCM append 帧与字节。`POST /api/local/realtime/diagnostics` 只接收 OpenAI 浏览器计数并再次校验；Qwen/GLM 计数来自本机 relay。文件以 0600 权限原子写入 `realtime-diagnostics/`，与学习数据库及迁移备份分开，旧连接报告不能覆盖新连接。非静音帧不是语音质量评分；Key、音频、正文、原始错误和事件 ID 不进入诊断。

OpenAILifecycle、QwenLifecycle、GLMLifecycle 分别控制配置确认和回应时序。OpenAI 动态策略仅发送 `session.type/instructions`；Qwen 的服务端 VAD 负责普通轮次 commit/create，学生发言会取消尚未发出的催促；GLM 的本机 VAD 提交后等待状态机允许再创建回应。工具参数在调用学习操作前按各服务商 schema 验证；无效参数返回固定错误结果，每轮学生输入最多一次自动修正。GLM 参数事件迟到仍可续答，重复调用不会重复执行。可恢复的取消竞争不会标记为断线，失败响应的安全错误不会被网络错误覆盖。

标准语音在生成输出与 TTS 前检查英语；系统朗读只有一个英文 utterance、固定英文 voice、volume=1。Realtime 通过英语约束及非英文转写到达后的中断保护控制输出，不能提前审核尚未到达的流式转写。

CaptionEvent 与语音解耦，播放开始才显示字幕，打断冻结进度，迟到结果不能复活已结束字幕。系统词边界优先使用真实事件；API 音频与 Realtime 的逐词位置为估计。中英字幕按整组显示，译文永不进入 TTS。PCM 播放使用 AudioWorklet 采集与连续重采样，音频按 AudioContext 时钟排队；生成完成后仍等待播放队列排空才结束字幕。开口打断立即丢弃队列，并拒绝已取消回答的迟到音频。

只读 subtitles 接口按 epoch + 老师 turnId 获取原文，使用分析模型翻译并在进程中缓存，不写学习证据。翻译在 8 秒超时后降级为英文，不遮挡已收到的原文。响应、播放与未到转写分别计时，失败和取消不会永久停在等待。Teaching Intent 面板仅展示公开摘要、教学安排及实际转写，不读取或展示上游 reasoning_content、reasoning_details 等隐藏推理字段。

实时上下文由 `local/realtime-context.ts` 计数，Qwen/GLM 达到轮次、上传时长或上游输入 token 阈值后，等待学生停顿、ASR 完成、老师音频生成及转写完成、无待处理工具和发送队列排空。`realtime-relay.ts` 保留同一个浏览器 WebSocket 和音频播放器，只替换上游连接；新生命周期关闭开场，配置 ACK 前至多在 RAM 暂存 10 秒 / 200 帧新输入。暂停清空这些帧，旧 socket 的迟到事件不会影响新连接。新提示词携带最多 4 条短交流及有限个人记忆，不发送旧音频。此过程不创建新的学习会话，也不启动课后分析。安全条件未满足时延后，阈值不是硬性 token 预算。

OpenAI 初始会话使用 `truncation: {type: "retention_ratio", retention_ratio: 0.6, token_limits: {post_instructions: 4000}}`；动态教学更新仍仅发送 type/instructions。三个 Provider 的历史配置互不套用。GLM 同一回复中的工具输出序号用于关联带/不带 call_id 的两类事件，已知真实 call_id 留在内存用于回传；合并事件后每个调用只执行一次。

`realtime-usage.ts` 只提取官方 usage 数值字段：Qwen 读取复数 `input_tokens_details/output_tokens_details`，OpenAI/GLM 读取单数形式，OpenAI 可另记录缓存明细。总计附带每个字段的报告覆盖次数，最多保留 64 条样本；缺失数值不补零，也不把缓存数重复加到输入。GLM 文档中的零值可能为占位值，不用于费用承诺。所有计数继续经过固定持久化白名单。
