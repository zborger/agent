/**
 * agent.ts —— 最小 agent loop（三件套：LLM + 工具 + 循环）
 *
 * 这是整个学习的核心文件。剥到最里层，任何 agent（Claude Code / Cursor / LangGraph）
 * 都是这个循环。读懂这 100 行，你就懂了 agent 的内核。
 *
 * 循环逻辑：
 *   1. 把对话历史 + 可用工具列表发给 LLM
 *   2. LLM 要么给最终答案（循环结束），要么要求调用工具
 *   3. 如果要调工具：我们的代码执行工具，把结果塞回对话历史
 *   4. 回到第 1 步，带着新结果再问 LLM
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
// 调 LLM 的逻辑（含错误分类 + 重试）统一放在 llm.ts，这里直接用。
import { callLLM, LLMError } from "./llm.ts";

// ────────────────────────────────────────────────────────────────
// 第 1 部分：工具（tools）—— agent 的"手脚"
// ────────────────────────────────────────────────────────────────

// 1a. 工具的"说明书"：告诉 LLM 有哪些工具、怎么用、参数是什么。
//     这个格式是 OpenAI/DeepSeek 约定的 function calling 规范。
//     LLM 看的是这段描述，然后决定要不要调、传什么参数。
const toolSchemas = [
  {
    type: "function",
    function: {
      name: "readFile",
      description: "读取一个文本文件的内容。当用户想知道某个文件里写了什么时使用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要读取的文件路径" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "writeFile",
      description: "把文本内容写入一个文件（若文件不存在则创建，存在则覆盖）。当用户要求创建文件或把内容保存到文件时使用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要写入的文件路径" },
          content: { type: "string", description: "要写入文件的文本内容" },
        },
        required: ["path", "content"],
      },
    },
  },
];

// 1b. 工具的"真身"：真正干活的代码。名字要和上面 schema 里的 name 对上。
//     LLM 只会说"我要调 readFile，参数 path=xxx"，真正读文件的是这里。
const toolImplementations: Record<string, (args: any) => Promise<string>> = {
  async readFile(args: { path: string }) {
    const content = await fsReadFile(args.path, "utf-8");
    return content;
  },
  async writeFile(args: { path: string; content: string }) {
    await fsWriteFile(args.path, args.content, "utf-8");
    // 工具要返回一个字符串结果喂回给模型，告诉它"干成了"。
    return `已写入文件 ${args.path}（${args.content.length} 字符）`;
  },
};

// ────────────────────────────────────────────────────────────────
// 第 2 部分：agent 循环 —— 灵魂所在
//   注意：调 LLM 现在用 llm.ts 里的 callLLM（自带错误分类和重试）。
//
// 输出约定（两类信息分流，别混）：
//   console.error → trace 诊断信息，给开发者看（走 stderr）
//   console.log   → 用户对话内容，给使用者看（走 stdout）
//   好处：`npm run agent 2> trace.log` 就能把日志扔进文件，屏幕只剩干净对话。
// ────────────────────────────────────────────────────────────────

async function runAgent(messages: any[]) {
  // 一个安全上限，防止模型抽风无限调工具烧 token。
  const MAX_STEPS = 10;
  // 累加整个任务的 token 消耗。用 let 因为要反复赋值。
  let totalTokens = 0;

  for (let step = 0; step < MAX_STEPS; step++) {
    console.error(`\n──── 第 ${step + 1} 轮 ────`);
    console.error(`[发送] messages 共 ${messages.length} 条`);

    // 【第 1 步】把历史 + 工具发给 LLM（tools 通过 options 传进去）
    // 解构赋值：从返回对象里取出 message（改名叫 reply）和 usage。
    const { message: reply, usage } = await callLLM(messages, { tools: toolSchemas });
    totalTokens += usage.total_tokens;

    // prompt_tokens 就是本轮发过去的 messages 大小 —— 盯着它看"上下文膨胀"
    console.error(
      `[用量] prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} 累计=${totalTokens}`,
    );

    // 把 LLM 这一轮的发言加进历史（不管它是要调工具还是给答案，都得记下来）
    messages.push(reply);

    // 【第 2 步】判断：LLM 要调工具吗？
    // 注意判据是"有没有 tool_calls"，不是"有没有 content"——
    // 模型可能一边说话一边调工具，两者同时存在。
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      // 没要调工具 → 说明它给出了最终答案 → 循环结束
      console.error(`[收到] 最终答案（无 tool_calls）→ 循环结束`);
      console.error(`[统计] 共 ${step + 1} 轮, 累计 ${totalTokens} tokens`);
      return reply.content;
    }

    // 有 tool_calls：先把模型这轮说的话给用户看（就是"我来读取这两个文件"这类过程说明）。
    // 不打出来的话，用户在工具执行期间只能对着空屏干等，不知道 agent 在干什么。
    if (reply.content) {
      console.log(`agent: ${reply.content}`);
    }

    // trace: 记录模型这轮的意图
    const intents = reply.tool_calls
      .map((tc: any) => `${tc.function.name}(${tc.function.arguments})`)
      .join(", ");
    console.error(`[决策] 要调用 ${reply.tool_calls.length} 个工具: ${intents}`);

    // 【第 3 步】它要调工具。逐个执行，把结果塞回历史。
    for (const toolCall of reply.tool_calls) {
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);

      let result: string;
      try {
        result = await toolImplementations[name](args);
        // 只打印长度，不打印全文 —— 文件内容可能很长，刷屏且没必要
        console.error(`[执行] ${name} → 成功, 返回 ${result.length} 字符`);
      } catch (err: any) {
        result = `工具执行出错: ${err.message}`;
        console.error(`[执行] ${name} → 失败: ${err.message}`);
      }

      // 把工具结果作为一条 role=tool 的消息塞回历史。
      // tool_call_id 要和 LLM 请求里的对上，模型才知道这是哪次调用的结果。
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: result,
      });
    }

    // 【第 4 步】不 return，for 循环回到顶部，带着工具结果再问 LLM。
  }

  return "（达到最大步数上限，agent 停止）";
}

// ────────────────────────────────────────────────────────────────
// 第 3 部分：外壳 —— 命令行对话，让你能跟 agent 聊天
// ────────────────────────────────────────────────────────────────

async function main() {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  // messages 就是 agent 的"记忆"。第一条是 system 提示，定义它是谁。
  const messages: any[] = [
    { role: "system", content: "你是一个乐于助人的助手。你可以使用工具来完成任务。" },
  ];

  console.log("最小 agent 已启动。输入问题开始对话，输入 exit 退出。\n");

  while (true) {
    const userInput = await rl.question("你: ");
    if (userInput.trim().toLowerCase() === "exit") break;

    messages.push({ role: "user", content: userInput });

    try {
      const answer = await runAgent(messages);
      console.log(`agent: ${answer}\n`);
    } catch (err) {
      if (err instanceof LLMError) {
        // 按分类给不同提示。致命的配置类错误直接退出，没必要继续。
        console.error(`\n[LLM 错误 / ${err.category}] ${err.message}\n`);
        if (!err.retryable) {
          console.error("这是配置类错误，重试也没用，先退出。修正后重新启动。");
          break;
        }
      } else {
        console.error("\n[意外错误]", err, "\n");
      }
    }
  }

  rl.close();
}

main();
