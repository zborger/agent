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

import { readFile as fsReadFile } from "node:fs/promises";
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
];

// 1b. 工具的"真身"：真正干活的代码。名字要和上面 schema 里的 name 对上。
//     LLM 只会说"我要调 readFile，参数 path=xxx"，真正读文件的是这里。
const toolImplementations: Record<string, (args: any) => Promise<string>> = {
  async readFile(args: { path: string }) {
    const content = await fsReadFile(args.path, "utf-8");
    return content;
  },
};

// ────────────────────────────────────────────────────────────────
// 第 2 部分：agent 循环 —— 灵魂所在
//   注意：调 LLM 现在用 llm.ts 里的 callLLM（自带错误分类和重试）。
// ────────────────────────────────────────────────────────────────

async function runAgent(messages: any[]) {
  // 一个安全上限，防止模型抽风无限调工具烧 token。
  const MAX_STEPS = 10;

  for (let step = 0; step < MAX_STEPS; step++) {
    // 【第 1 步】把历史 + 工具发给 LLM（tools 通过 options 传进去）
    const reply = await callLLM(messages, { tools: toolSchemas });

    // 把 LLM 这一轮的发言加进历史（不管它是要调工具还是给答案，都得记下来）
    messages.push(reply);

    // 【第 2 步】判断：LLM 要调工具吗？
    if (!reply.tool_calls || reply.tool_calls.length === 0) {
      // 没要调工具 → 说明它给出了最终答案 → 循环结束
      return reply.content;
    }

    // 【第 3 步】它要调工具。逐个执行，把结果塞回历史。
    for (const toolCall of reply.tool_calls) {
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`  [agent 调用工具] ${name}(${JSON.stringify(args)})`);

      let result: string;
      try {
        result = await toolImplementations[name](args);
      } catch (err: any) {
        result = `工具执行出错: ${err.message}`;
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
// 第 4 部分：外壳 —— 命令行对话，让你能跟 agent 聊天
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
