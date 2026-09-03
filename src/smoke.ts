/**
 * smoke.ts —— 一次性冒烟测试（验证 loop + 工具调用整条链路）
 *
 * 不用交互，直接喂一个"必须读文件才能回答"的任务，看 agent 会不会：
 *   调用 readFile 工具 → 拿到内容 → 基于内容回答。
 * 验证通过后这个文件可以删掉，或留着当回归测试。
 */

import { readFile as fsReadFile } from "node:fs/promises";
import { callLLM } from "./llm.ts";

const toolSchemas = [
  {
    type: "function",
    function: {
      name: "readFile",
      description: "读取一个文本文件的内容。当用户想知道某个文件里写了什么时使用。",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "要读取的文件路径" } },
        required: ["path"],
      },
    },
  },
];

const toolImplementations: Record<string, (args: any) => Promise<string>> = {
  async readFile(args: { path: string }) {
    return await fsReadFile(args.path, "utf-8");
  },
};

async function runAgent(messages: any[]) {
  for (let step = 0; step < 10; step++) {
    const reply = await callLLM(messages, { tools: toolSchemas });
    messages.push(reply);
    if (!reply.tool_calls || reply.tool_calls.length === 0) return reply.content;
    for (const tc of reply.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments);
      console.log(`  [调用工具] ${name}(${JSON.stringify(args)})`);
      let result: string;
      try {
        result = await toolImplementations[name](args);
      } catch (e: any) {
        result = `工具出错: ${e.message}`;
      }
      messages.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
  return "（达到步数上限）";
}

const messages: any[] = [
  { role: "system", content: "你是一个乐于助人的助手，可以使用工具完成任务。" },
  { role: "user", content: "读一下 tsconfig.json，告诉我它的编译目标 target 是什么？" },
];

console.log("任务: 读 tsconfig.json 看 target\n");
const answer = await runAgent(messages);
console.log(`\nagent 最终回答: ${answer}`);
