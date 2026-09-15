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

## 待办 / 下一步

- [x] 加更多工具（writeFile 已完成）。
- [ ] 故意给多步任务，观察 messages 膨胀 → 引出上下文管理（下一堵墙）。
- [ ] 给工具调用加兜底：未知工具名、坏 JSON 参数的防护。
