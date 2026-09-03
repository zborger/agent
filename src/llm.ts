/**
 * llm.ts —— 调用 LLM 的统一入口 + 错误处理 + 重试
 *
 * 为什么单独抽一个文件？
 *   ping.ts 和 agent.ts 都要调 LLM。把"怎么调、出错怎么办、要不要重试"
 *   这套逻辑集中在这里，将来换模型/换厂商（DeepSeek → 通义 → 你们公司网关）
 *   只改这一个文件，上层代码一个字不用动。
 *
 * 错误处理的设计原则（重要）：
 *   不照抄 DeepSeek 的错误码逐个 switch，而是按"程序该怎么应对"分三类：
 *     - 可重试(retryable)：临时故障，等一下自动重试   → 429/500/503
 *     - 致命(fatal)：不改配置重试也没用，立刻停并报人 → 400/401/402/422
 *     - 未知：没见过的码，保守当致命处理，不瞎重试
 *   这个分类跨模型、跨厂商通用。将来自动选模型时，"可重试"还能触发"换个模型再试"。
 */

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
const MODEL = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";

// ────────────────────────────────────────────────────────────────
// 统一的错误类型：上层只看 retryable，不用关心原始 HTTP 码
// ────────────────────────────────────────────────────────────────
export class LLMError extends Error {
  /** HTTP 状态码（可能为 0，表示网络层错误，比如断网/超时） */
  readonly status: number;
  /** 是否值得重试。上层据此决定退避重试还是直接放弃。 */
  readonly retryable: boolean;
  /** 给人看的原因分类，方便日志排查 */
  readonly category: "retryable" | "auth" | "quota" | "bad_request" | "server" | "network" | "unknown";

  constructor(message: string, status: number, retryable: boolean, category: LLMError["category"]) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.retryable = retryable;
    this.category = category;
  }
}

/**
 * 把 HTTP 状态码翻译成"程序该怎么应对"。
 * 这是整个文件里【唯一】和具体错误码耦合的地方 —— 换厂商时只需改这里。
 */
function classifyError(status: number, body: string): LLMError {
  switch (status) {
    // —— 可重试：临时性故障，退避后重试 ——
    case 429: // 请求速率达上限 (TPM/RPM)
      return new LLMError(`请求速率达到上限 (429): ${body}`, status, true, "retryable");
    case 500: // 服务器内部故障
      return new LLMError(`服务器故障 (500): ${body}`, status, true, "server");
    case 503: // 服务器繁忙
      return new LLMError(`服务器繁忙 (503): ${body}`, status, true, "server");

    // —— 致命：不改配置重试也没用，立刻停 ——
    case 401: // 认证失败，key 错
      return new LLMError(`认证失败 (401)：API key 错误或无效。请检查 .env 里的 DEEPSEEK_API_KEY。`, status, false, "auth");
    case 402: // 余额不足
      return new LLMError(`余额不足 (402)：账户余额不足，请前往 DeepSeek 平台充值。`, status, false, "quota");
    case 400: // 请求体格式错误
      return new LLMError(`请求格式错误 (400): ${body}`, status, false, "bad_request");
    case 422: // 参数错误
      return new LLMError(`参数错误 (422): ${body}`, status, false, "bad_request");

    // —— 未知：保守处理，当致命，不瞎重试 ——
    default:
      // 4xx 一律当致命（客户端问题），5xx 当可重试（服务端问题），这是通用兜底策略
      if (status >= 500) {
        return new LLMError(`未知服务器错误 (${status}): ${body}`, status, true, "server");
      }
      return new LLMError(`未知错误 (${status}): ${body}`, status, false, "unknown");
  }
}

/** 睡 ms 毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调用 LLM 的 /chat/completions，自带对"可重试"错误的指数退避重试。
 *
 * @param messages 完整对话历史（记忆靠调用方维护并整段传入）
 * @param options.tools 可选的工具说明书
 * @param options.maxRetries 可重试错误的最大重试次数，默认 3
 * @returns 模型这一轮的 message 对象（可能含 tool_calls）
 * @throws LLMError 致命错误，或重试用尽仍失败
 */
export async function callLLM(
  messages: any[],
  options: { tools?: any[]; maxRetries?: number } = {},
): Promise<any> {
  if (!API_KEY) {
    throw new LLMError("没读到 DEEPSEEK_API_KEY。确认 .env 里填了 key，并用 npm 脚本启动。", 0, false, "auth");
  }

  const maxRetries = options.maxRetries ?? 3;
  let lastError: LLMError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 第 2 次及以后：先按指数退避等一会儿（1s, 2s, 4s...）
    if (attempt > 0) {
      const backoffMs = 1000 * 2 ** (attempt - 1);
      console.error(`  [重试] 第 ${attempt}/${maxRetries} 次，等待 ${backoffMs}ms... (${lastError?.message})`);
      await sleep(backoffMs);
    }

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          ...(options.tools ? { tools: options.tools } : {}),
        }),
      });
    } catch (err: any) {
      // fetch 抛异常 = 网络层问题（断网、DNS、超时），可重试
      lastError = new LLMError(`网络错误: ${err.message}`, 0, true, "network");
      continue;
    }

    if (response.ok) {
      const data = await response.json();
      return data.choices[0].message;
    }

    // 非 2xx：分类
    const body = await response.text();
    const error = classifyError(response.status, body);

    if (!error.retryable) {
      // 致命错误，别浪费时间重试，直接抛
      throw error;
    }
    // 可重试，记下来，进入下一轮循环
    lastError = error;
  }

  // 重试用尽仍失败
  throw lastError ?? new LLMError("调用失败，原因未知", 0, false, "unknown");
}
