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

## 待办 / 下一步

- [ ] 故意给多步任务，观察 messages 膨胀 → 引出上下文管理（下一堵墙）。
- [ ] 可能加更多工具（写文件、执行命令），让 agent 能真正操作项目。
