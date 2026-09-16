# my-agent

从零手写一个最小 AI agent。不用 LangChain / LangGraph 之类的框架，TypeScript + `fetch` 裸调 DeepSeek，运行期零依赖。

目的是理解 agent 的内核，而不是学会用某个框架。方法是**先写最小可运行的 loop，撞到问题，再引入解决那个问题的能力** —— 每个高级特性都在亲身遇到它要解决的痛点之后才加进来。

## 核心信条

> **Agent = LLM（决策） + 工具（行动） + 循环（把行动结果喂回，驱动下一轮决策）**

其余一切（上下文压缩、规划、子 agent、记忆）都是往这个内核上挂的扩展。

## 快速开始

```bash
npm install
cp .env.example .env    # 然后填入你的 DEEPSEEK_API_KEY
npm run agent           # 启动命令行对话
npm run ping            # 只验证一次 API 调用是否通
```

诊断日志走 stderr、对话内容走 stdout，所以可以分离：

```bash
npm run agent 2> trace.log    # 屏幕只留干净对话，trace 进文件
```

## 项目结构

```
src/
├── agent.ts    # 核心 loop + 工具定义 + CLI 外壳
├── llm.ts      # 调用封装：错误分类、指数退避重试
└── ping.ts     # 最原始的一次调用，用来证明"调 LLM 就是一次 HTTP POST"
DEVLOG.md       # 开发日志：每个阶段的认知、决策理由、踩坑记录
```

## 当前能力

- ReAct 循环（思考 → 行动 → 观察 → 再思考），模型自主决定走几步、何时停
- 工具：`readFile`、`writeFile`、`listFiles`
- 环境感知：system prompt 注入工作目录，模型会主动 `listFiles` 探索而非猜路径
- Trace 可观测性：每轮打印 messages 条数、token 用量、模型决策、工具执行结果
- 错误处理：LLM 错误三分类 + 重试；工具调用三层兜底

## 关键设计取舍

**循环的结束判据是「没有 tool_calls」，不是「有 content」**
模型可能一边说话一边调工具（实测："我来读取这两个文件。" + 2 个 `readFile`）。若用 content 判断结束，会在工具执行前提前退出。

**LLM 错误按「程序该怎么应对」分类，而非照抄错误码**
分三类：可重试（429/500/503，指数退避）、致命（401/402/400/422，立刻停并报人）、未知（保守当致命）。只有一个 `classifyError` 函数跟具体错误码耦合，换模型或换厂商只改这一处。

**工具出错不抛异常，而是把错误当作工具结果喂回给模型**
模型是概率输出的，一定会犯浑 —— 幻觉出不存在的工具名、生成不合法的 JSON 参数。让程序崩掉是最差的选择；把"未知工具 x，可用的只有 a/b/c"回传给它，它下一轮就能自我纠正。

**给模型的能力必须配安全边界**
`writeFile` 会校验目标路径解析后是否仍在项目目录内，防止模型幻觉出 `../../../` 覆盖掉外部文件。

## 演进路线

- [x] 最小 loop 跑通（LLM + 工具 + 循环）
- [x] Trace 可观测性，用真实 token 数据观察上下文膨胀
- [x] 环境感知 + 工具调用兜底
- [ ] 上下文管理（滑动窗口 + 工具结果裁剪；注意 `tool_calls`/`tool` 必须成对，不能切断）
- [ ] 规划 / TodoList，应对长任务中途迷失目标
- [ ] 子 agent 委派
- [ ] 工具真并行执行

## 备注

每个阶段的详细思考、实测数据和踩过的坑都记在 [DEVLOG.md](./DEVLOG.md) 里，包括一些被推翻的判断。

模型默认 `deepseek-v4-flash`（快、便宜），在 `.env` 里改 `DEEPSEEK_MODEL` 即可切换，代码无需改动。DeepSeek 是 OpenAI 兼容接口，换其他兼容厂商同理。
