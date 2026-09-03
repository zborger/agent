/**
 * ping.ts —— 第 0 步：证明"调 LLM 就是一次普通的 HTTP 请求"
 *
 * 这里没有 loop、没有工具、没有 agent。
 * 只做一件事：把一句话发给 DeepSeek，把它的回答打印出来。
 * 目的是让你亲眼看到 —— 所谓"调大模型"，本质就是 地址 + token + body 的一次 POST。
 */

// Node 22 自带 fetch，不需要装任何库。
// 从环境变量读 key（我们等下用 --env-file 把 .env 注入进来）。
const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-chat";

if (!API_KEY) {
  console.error("没读到 DEEPSEEK_API_KEY。确认 .env 里填了 key，并且用 npm run ping 启动。");
  process.exit(1);
}

async function main() {
  // 这就是"调 LLM"的全部：往 /chat/completions 发一个 POST。
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // token 放在这里，格式是 "Bearer <key>"
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "user", content: "用一句话介绍你自己。" },
      ],
    }),
  });

  if (!response.ok) {
    console.error("请求失败:", response.status, await response.text());
    process.exit(1);
  }

  // 响应是 JSON。模型的回答藏在 choices[0].message.content 里。
  const data = await response.json();
  console.log("原始响应结构:");
  console.log(JSON.stringify(data, null, 2));
  console.log("\n模型的回答是:");
  console.log(data.choices[0].message.content);
}

main();
