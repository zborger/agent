# Agent 开发日志

从零手写一个最小 agent，边做边加能力。核心信条：**Agent = LLM + 工具 + 循环**，其余都是往这个内核上挂的扩展。

记录方式：每有进展/踩坑/决策，追加一条，尽量一两行。

---

## 阶段 0 · 骨架搭建

- 语言 TS，模型 DeepSeek（OpenAI 兼容，`fetch` 裸调，先不上任何框架）。
- 项目结构：`src/ping.ts`（验证一次调用）、`src/agent.ts`（核心 loop）、`src/llm.ts`（调用+错误处理）。
- git：`my-agent/` 独立仓库，提交身份 `zborger`，与公司全局配置隔离。远程 `github.com/zborger/agent`。

## 关键认知

- LLM 是**无状态**的：服务端不存对话，"记忆"就是每次请求整段发过去的 `messages` 数组。
- 在 agent 里**一切都是 messages**：用户输入、模型回复、工具调用、工具结果，全 push 进同一个数组。
- 因此 messages 会随对话膨胀 → 后面必然要撞"上下文压缩"这堵墙。

## 决策记录

- **模型名**用 `deepseek-v4-flash`（快、便宜），`.env` 可改 `deepseek-v4-pro`，代码不用动。
- **错误处理**不照抄错误码，按"程序该怎么应对"分三类：可重试(429/500/503) / 致命(400/401/402/422) / 未知。
  - 只有 `llm.ts` 的 `classifyError` 跟具体错误码耦合，换模型/换厂商只改这一处。
  - 可重试错误做指数退避重试（1s/2s/4s）。为将来"自动选模型"预留了空间。

---

## 阶段 1 · 最小 loop 跑通 ✅

- `npm run ping` 通了：确认调 LLM = 一次 HTTP POST，回答在 `choices[0].message.content`。
- `smoke.ts` 冒烟测试通过：问"tsconfig 的 target 是什么" → agent 自主调 `readFile` → 读到内容 → 答出 `ES2022`。完整 ReAct 循环成立。
- 踩坑：PowerShell 控制台默认 GBK，Node 输出 UTF-8，中文乱码。跑之前设 `[Console]::OutputEncoding=UTF8` 即可，数据本身没问题。
- 注意：v4 模型响应里带 `reasoning_content`（思考过程），以后可利用。

## 阶段 2 · 扩展工具 + 深化理解

- 加了 `writeFile` 工具：改两处（toolSchemas 说明书 + toolImplementations 真身）+ 顶部 import。验证了"改 schema → agent 的自我认知和能力就变"。
- 工具必须 `return` 一句有意义的结果 → 被 push 回 messages(role:tool) → 模型据此判断"这步成没成"、决定下一步。工具结果 = loop 的"观察"环节。

## 关键认知（第二批）

- **响应分两层**：外层信封(choices/message/role/tool_calls结构)由厂商服务端代码保证 100% 稳定；内层内容(content文字、arguments值)才是模型概率生成、可能出错。
- **function calling 是训练出来的**：模型经过后训练学会"看到 tools schema 就按格式输出 tool_call"。所以 schema 描述越清晰，输出越准 —— 但永远是高概率、非保证，代码要处处兜底(JSON.parse 可能失败、工具名可能是幻觉)。
- **入参必须结构化**：messages 每条必须带 role(system/user/assistant/tool)，不能是裸文本；服务端先校验格式(不合格直接 400/422 不进模型)。
- **loop 结束判据是"没有 tool_calls"，不是"有 content"**（模型可能边说话边调工具，两者同时存在）。是模型自己决定走几步、何时停 —— 这就是自主性来源。
- **双循环心智**：外层 = CLI/对话循环(在 main，人驱动，靠 "exit" 字符串退出，是可替换的壳)；内层 = agent loop(在 runAgent，模型驱动，靠 tool_calls 退出，是不可替换的核)。换 HTTP/定时任务等外壳只动外层，runAgent 不变。
- **loop 是骨架但不是难点**：真正的工程价值在 loop 之外(memory 压缩、runtime 容错、tool 设计)。类比：请求-响应循环之于 Web 服务器。

## 阶段 3 · 加 trace 可观测性 + 亲眼看到膨胀

- `callLLM` 改为返回 `{ message, usage }`（原来只返回 message，usage 被丢弃）。底层只返数据不做打印，打印权交给上层。
- `runAgent` 加 trace：每轮打印 messages 条数、prompt/completion/累计 token、模型 content、决策要调的工具及参数、工具返回字符数、总统计。
- 删掉 `smoke.ts`：与 agent.ts 重复（抄了一份 runAgent），历史任务已完成，维护成本 > 价值。
- 补 tsconfig 的 `allowImportingTsExtensions`，`npx tsc` 类型检查可用。

### 实测数据（上下文膨胀的真实形状）

| 任务 | prompt 变化 |
|---|---|
| 读 2 个配置文件 | 440 → 811 |
| 只闲聊一句（零工具调用） | 1928（历史全在，打招呼也要为全部历史付费） |
| 读 2 个源码文件(5787+1366字符) | 3020 → **5565** |

四轮对话累计 10105 tokens。结论：**成本按"整个历史长度"计费，而非"你说了多少"，且历史只增不减。** 趋势已明确，无需真撞爆（省钱）。

### 观察到的现象

- **一轮返回多个 tool_calls**：模型判断任务间无依赖时会一次性提出多个（tool_calls 本就是数组，协议支持，无需开启）。但**我们的代码是 for+await 串行执行**——"模型一次提出多个" ≠ "并行执行"，想真并行要用 `Promise.all`。
- **content 与 tool_calls 同时出现**（实测："我来读取这两个文件。" + 2 个 readFile）→ 实证了"结束判据必须看 tool_calls 而非 content"，否则会在执行工具前提前退出。
- **ReAct 的推理链有效**：模型先读了 package.json（含 `src/agent.ts` 路径），后续就填对了路径。不是"知道"，是从上下文推理。环境盲区问题仍在。
- **已知缺陷**：中间轮次的 content 被丢弃（runAgent 只 return 最后一轮），用户看不到"我来读取…"这类过程说明。

## 架构认知 · 外壳可替换（HTTP 化的思考）

- **内核不变**（占工程 80%）：runAgent 循环、工具 schema、messages 拼装/tool_call_id 配对、上下文管理、错误重试。
- **换外壳要改**：输入源（stdin → request body）、输出（console.log → 流式推送）、**messages 存储（内存数组 → Redis/DB 按 userId+sessionId，这是最大改动）**、并发限流、身份透传（且绝不能让模型篡改身份）。
- 上下文管理逻辑本身不随存储方案改变，现在学的照样用。
- 保持 runAgent 纯净、不依赖 CLI 特有的东西 → 将来能直接复用。学习阶段直接 console.log 可以，但心里清楚这是耦合点。

### 传输协议：不是单一答案（纠正早先的错误判断）

分两层，各用各的协议，不矛盾：

```
前端 ←─WebSocket(socket.io)─→ 自研 Agent 服务 ─SSE/HTTP→ 模型 API
                                              └─MCP→ 网关 → 业务服务
```

| 场景 | 常见选择 | 理由 |
|---|---|---|
| 模型 API 层 | SSE（streamable-http） | 单向吐 token，基建简单 |
| MCP 协议 | HTTP + SSE | 请求-响应模式 |
| 面向用户的聊天产品 | **WebSocket 居多** | 需双向：中断生成、交互确认、多类事件（状态/进展/打字指示） |

**实证**：麦当劳 BOSS 员工平台 AI 机器人用 `socket.io`（WebSocket）。另从其接口名 `queryAtAgents` 推测是多 agent 架构（@某个专门 agent），对应以后要学的"多 agent / 子 agent 委派"。

### 自研编排还需要 MCP 吗

- **不需要**：调用方与被调方都是自己的内网 Java 服务、工具集固定、只有一个 agent 消费 → 直接 RPC 更简单。
- **需要**：多个不同 AI 客户端要调同一批能力、工具要能被动态发现(tools/list)而非硬编码、跨团队/外部开放、认证限流审计要集中治理。
- 两者不冲突，是两类消费方。我们公司做 MCP 正是为了让外部 AI 客户端（Kiro/Claude Desktop）能调，所以要留着。

## 阶段 4 · 治环境盲区 + 工具兜底

### 做了三件事

1. **`listFiles` 工具**：`readdir({withFileTypes:true})` 区分目录/文件输出，让模型知道哪个能继续钻。**过滤 node_modules 和 .git**（条目巨多，不过滤会瞬间灌满上下文）。
2. **system prompt 注入环境**：工作目录 `process.cwd()` + 操作系统，并明确指示"不确定文件在哪就先 listFiles，不要凭猜测直接读"。
3. **三层工具兜底**——核心手法是**不抛异常让程序崩，而是把错误当作工具结果喂回给模型**，让它看到错在哪、自我纠正：
   - 坏 JSON：原来 `JSON.parse` 在 try 外面，一崩就整个挂。现在捕获并回传"你的 JSON 不合法 + 原始内容"。
   - 幻觉工具名：原来取到 `undefined` 直接崩。现在回传"未知工具 x，可用的只有：..."。
   - `writeFile` 路径越界：`path.resolve` 后校验是否仍在项目目录内，越界拒绝并说明原因。

### 效果实测

一句"你好，现在你知道文件结构吗"，决策链变成了完整的"探索→行动"：

```
第1轮 prompt=581  → listFiles(".")                                  先看根目录
第2轮 prompt=757  → listFiles("src") + readFile(package.json) + readFile(DEVLOG.md)   一次并发3个，选得很准
第3轮 prompt=3323 → 综合信息给出完整结构                             一轮涨4.4倍(DEVLOG 4528字符入context)
```

对比之前靠运气猜路径 → 现在**主动先探索**。**一句 system 提示改变了它的行为模式。**

### 两个值得记住的观察

- **文档滞后于代码会让 agent 给出过时建议**：它读了旧版 DEVLOG，把已完成的事列成待办、还建议"先做工具兜底"（刚做完）。但它同时发现了 `smoke.ts` 已删与文档不符并主动纠正——说明它在对比"实际观察"和"文档描述"。**信息源与现实不一致，是 RAG/记忆系统的经典问题。**
- **加强探索能力 = 加速上下文膨胀**（如预判）：能读更多文件 → 膨胀更快。一个简单问题就烧 5586 tokens，**上下文管理的时机到了**。

### 关于"agent 的认知"

亲手写完 loop 后会产生一种"它好像有认知"的冲击感。清醒的看法：所谓认知全部发生在那个 for 循环里——它没有记忆(记忆是我们 push 的数组)、没有目标感(目标是 system prompt)、不知道自己做过什么(除了喂回去的)。冲击感的真正来源是**意识到只需要这么少的脚手架**：一百行 + 训练好的模型，就能产生像自主推理的行为。这个认知比"它好聪明"重要——它同时界定了能力边界和不可信之处。

## 上下文管理策略（下一步的选型）

| 策略 | 做法 | 取舍 |
|---|---|---|
| 1. 滑动窗口 | 只留 system + 最近 N 条 | 最简单；但会丢信息，且**不能瞎切** |
| 2. 摘要压缩 | 老消息交给 LLM 总结成一段替换原文 | 保留关键信息；多花一次 LLM 调用、丢细节 |
| 3. 工具结果裁剪 | 老的工具结果替换成"（已读 x.md，4528字符，内容略）" | **精准打击最大膨胀源**，不花钱；模型可能需重读 |
| 4. 混合（生产级） | 平时 1+3，快撞上限时触发 2 | 复杂度最高 |

**计划：先做 1 + 3**（覆盖 80% 膨胀且零额外成本），摘要压缩留后。

**⚠️ 实现坑**：滑动窗口不能瞎切。`assistant(tool_calls)` 与 `tool(结果)` 必须成对，切在中间会留下"孤儿 tool 消息"或"有 tool_calls 但无结果的 assistant"，DeepSeek 直接报 400。

## 待办 / 下一步

- [x] 加更多工具（writeFile、listFiles）。
- [x] 观察 messages 膨胀（trace 已加，数据已收集）。
- [x] 打印中间轮次 content；trace 走 stderr、用户输出走 stdout。
- [x] `listFiles` + system 注入工作目录（治环境盲区）。
- [x] 工具调用兜底：坏 JSON、未知工具名、writeFile 路径越界。
- [ ] **上下文管理**（时机已到）：滑动窗口 + 工具结果裁剪，注意 tool_calls/tool 配对不能切断。
- [ ] 之后：规划/TodoList、子 agent 委派、真并行执行工具（Promise.all）。
