import { describe, expect, it, vi } from "vitest";
import { ClaudeBackend, DeepSeekBackend, ProviderError, type FetchLike } from "./providers";
import type { GenerationEvent, ModelBackend, WritingTask } from "./index";

const KEY = "private-api-key-must-never-appear";
const config = { apiKey: KEY, model: "user-selected-model" };
const task: WritingTask = {
  id: "request-1", instruction: "解释为什么需要下一步。", targetNodeId: "n2",
  question: "这里为什么成立？",
  context: [{ id: "n1", revision: "r1", text: "已知背景。" }, { id: "n2", revision: "r2", text: "因此得到结论。" }],
};
const signal = () => new AbortController().signal;

function data(value: unknown, event?: string): string {
  return `${event ? `event: ${event}\r\n` : ""}data: ${typeof value === "string" ? value : JSON.stringify(value)}\r\n\r\n`;
}

function response(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  let cursor = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (cursor === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.slice(cursor, cursor + chunkSize));
      cursor = Math.min(cursor + chunkSize, bytes.length);
    },
  }), { headers: { "content-type": "text/event-stream; charset=utf-8" } });
}

function deepText(text: string): string { return data({ choices: [{ delta: { content: text }, finish_reason: null }] }); }
function deepComplete(): Response {
  return response(deepText("草稿") + data({ choices: [{ delta: {}, finish_reason: "stop" }] }) + data("[DONE]"));
}
function claudeStart(usage?: Record<string, number>): string {
  return data({ type: "message_start", message: { usage } }, "message_start");
}
function claudeText(text: string): string {
  return data({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }, "content_block_delta");
}
function claudeStop(reason = "end_turn", usage?: Record<string, number>): string {
  return data({ type: "message_delta", delta: { stop_reason: reason }, usage }, "message_delta")
    + data({ type: "message_stop" }, "message_stop");
}
async function collect(backend: ModelBackend, request = task, abortSignal = signal()): Promise<GenerationEvent[]> {
  const events: GenerationEvent[] = [];
  for await (const event of backend.generate(request, abortSignal)) events.push(event);
  return events;
}
async function failure(backend: ModelBackend, events: GenerationEvent[] = [], abortSignal = signal()): Promise<unknown> {
  try {
    for await (const event of backend.generate(task, abortSignal)) events.push(event);
  } catch (error) { return error; }
  throw new Error("Expected generation to fail");
}

describe("DeepSeek streaming", () => {
  it("decodes split UTF-8/CRLF and multiline SSE, ignores reasoning, and preserves optional usage", async () => {
    const stream = ": keepalive\r\nid: 1\r\n\r\n"
      + data({ choices: [{ delta: { reasoning_content: "private reasoning" } }] })
      + 'data: {"choices":\r\ndata: [{"delta":{"content":"证明："}}]}\r\n\r\n'
      + deepText("\n\n先看前提。")
      + data({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 120, completion_tokens: 15, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 20 } })
      + "data: [DONE]"; // final record without the customary final separator
    const events = await collect(new DeepSeekBackend(config, async () => response(stream, 1)));
    expect(events).toEqual([
      { type: "text", text: "证明：" }, { type: "text", text: "\n\n先看前提。" },
      { type: "usage", backendId: "deepseek", usage: { inputTokens: 120, outputTokens: 15, cacheReadInputTokens: 100, uncachedInputTokens: 20 } },
      { type: "done", backendId: "deepseek", simulated: false },
    ]);
  });

  it("uses stable messages, explicit models, official defaults and injected transport", async () => {
    const fetcher = vi.fn<FetchLike>(async () => deepComplete());
    const backend = new DeepSeekBackend({ ...config, maxOutputTokens: 300 }, fetcher);
    await collect(backend);
    await collect(backend, { ...task, id: "different-request-id" });
    await collect(backend, { ...task, instruction: "改为解释该假设。" });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: `Bearer ${KEY}` });
    expect(init?.redirect).toBe("error");
    const body = JSON.parse(init?.body as string);
    expect(body).toMatchObject({ model: "user-selected-model", max_tokens: 300, stream: true, stream_options: { include_usage: true } });
    expect(body.messages.map((message: { role: string }) => message.role)).toEqual(["system", "user"]);
    expect(body.messages[1].content).toContain("这里为什么成立？");
    expect(body.messages[1].content).not.toContain(task.id);
    expect(fetcher.mock.calls[1]![1]?.body).toBe(init?.body);
    const next = JSON.parse(fetcher.mock.calls[2]![1]?.body as string);
    expect(next.messages[0]).toEqual(body.messages[0]);
    expect(next.messages[1].content.split("Writing request:")[0]).toBe(body.messages[1].content.split("Writing request:")[0]);
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(backend)).not.toContain(KEY);
  });

  it("accepts compatibility usage-only chunks and does not invent missing token counts", async () => {
    const events = await collect(new DeepSeekBackend(config, async () => response(
      deepText("段落") + data({ choices: [], usage: { prompt_tokens_details: { cached_tokens: 6 }, completion_tokens: -1 } }) + data("[DONE]"),
    )));
    expect(events.filter(event => event.type === "usage")).toEqual([
      { type: "usage", backendId: "deepseek", usage: { cacheReadInputTokens: 6 } },
    ]);
  });
});

describe("Claude streaming", () => {
  it("handles event sequences, ignores thinking, and replaces cumulative usage", async () => {
    const fetcher = vi.fn<FetchLike>(async () => response(
      claudeStart({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 1 })
      + data({ type: "ping" }, "ping")
      + data({ type: "content_block_start", index: 0, content_block: { type: "text", text: "先" } }, "content_block_start")
      + data({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "not article text" } }, "content_block_delta")
      + claudeText("说明前提。")
      + data({ type: "future_compatible_event" }, "future_compatible_event")
      + claudeStop("end_turn", { output_tokens: 8 }), 1,
    ));
    const backend = new ClaudeBackend({ ...config, baseURL: "https://api.anthropic.com/v1/" }, fetcher);
    const events = await collect(backend);
    expect(events).toEqual([
      { type: "usage", backendId: "claude", usage: { inputTokens: 35, uncachedInputTokens: 10, cacheReadInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 1 } },
      { type: "text", text: "先" }, { type: "text", text: "说明前提。" },
      { type: "usage", backendId: "claude", usage: { inputTokens: 35, uncachedInputTokens: 10, cacheReadInputTokens: 20, cacheWriteInputTokens: 5, outputTokens: 8 } },
      { type: "done", backendId: "claude", simulated: false },
    ]);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init?.headers).toMatchObject({ "x-api-key": KEY, "anthropic-version": "2023-06-01" });
    const body = JSON.parse(init?.body as string);
    expect(body.system).toContain("Return only the proposed Markdown passage");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe("user");
    expect(body).not.toHaveProperty("tools");
    expect(JSON.stringify(backend)).not.toContain(KEY);
  });

  it("keeps unknown cache values and total input absent", async () => {
    const events = await collect(new ClaudeBackend(config, async () => response(
      claudeStart({ input_tokens: 12 }) + claudeText("正文") + claudeStop("end_turn", { output_tokens: 4 }),
    )));
    expect(events.filter(event => event.type === "usage")).toEqual([
      { type: "usage", backendId: "claude", usage: { uncachedInputTokens: 12 } },
      { type: "usage", backendId: "claude", usage: { uncachedInputTokens: 12, outputTokens: 4 } },
    ]);
  });

  it("does not accept content before message_start or tool requests", async () => {
    for (const stream of [
      claudeText("正文") + claudeStop(),
      claudeStart() + data({ type: "content_block_start", content_block: { type: "tool_use", name: "unexpected" } }),
    ]) {
      expect(await failure(new ClaudeBackend(config, async () => response(stream)))).toMatchObject({ code: "protocol" });
    }
  });
});

describe("completion integrity", () => {
  it.each([
    ["DeepSeek", DeepSeekBackend, deepText("不完整草稿")],
    ["Claude", ClaudeBackend, claudeStart() + claudeText("不完整草稿")],
  ] as const)("%s rejects early EOF after yielding partial text", async (_name, Backend, stream) => {
    const events: GenerationEvent[] = [];
    const error = await failure(new Backend(config, async () => response(stream)), events);
    expect(error).toMatchObject({ code: "incomplete" });
    expect(events).toEqual([{ type: "text", text: "不完整草稿" }]);
  });

  it.each([
    ["DeepSeek", DeepSeekBackend, deepText("截断") + data({ choices: [{ delta: {}, finish_reason: "length" }] }) + data("[DONE]")],
    ["Claude", ClaudeBackend, claudeStart() + claudeText("截断") + claudeStop("max_tokens")],
  ] as const)("%s rejects a terminal event with a truncation reason", async (_name, Backend, stream) => {
    expect(await failure(new Backend(config, async () => response(stream)))).toMatchObject({ code: "incomplete" });
  });

  it.each([
    ["DeepSeek", DeepSeekBackend, deepText(" \n") + data("[DONE]")],
    ["Claude", ClaudeBackend, claudeStart() + claudeText(" \n") + claudeStop()],
  ] as const)("%s rejects empty or whitespace-only output", async (_name, Backend, stream) => {
    expect(await failure(new Backend(config, async () => response(stream)))).toMatchObject({ code: "empty-output" });
  });
});

describe("credential-safe failures", () => {
  it.each([[401, "authentication"], [429, "rate-limit"], [500, "http"]] as const)("sanitizes HTTP %i without reading its body", async (status, code) => {
    const raw = new Response(`error containing ${KEY}`, { status, statusText: KEY });
    const readBody = vi.spyOn(raw, "text");
    const error = await failure(new DeepSeekBackend(config, async () => raw));
    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code, status });
    expect(String(error)).not.toContain(KEY);
    expect(JSON.stringify(error)).not.toContain(KEY);
    expect(error).not.toHaveProperty("cause");
    expect(readBody).not.toHaveBeenCalled();
  });

  it("discards sensitive transport and streamed error text", async () => {
    const backends = [
      new DeepSeekBackend(config, async () => { throw new Error(KEY); }),
      new DeepSeekBackend(config, async () => response(data({ error: { message: KEY } }))),
      new ClaudeBackend(config, async () => response(data({ type: "error", error: { message: KEY } }, "error"))),
      new ClaudeBackend(config, async () => response(`data: ${KEY}\n\n`)),
    ];
    for (const backend of backends) {
      const error = await failure(backend);
      expect(error).toBeInstanceOf(ProviderError);
      expect(String(error)).not.toContain(KEY);
      expect(JSON.stringify(error)).not.toContain(KEY);
      expect(error).not.toHaveProperty("cause");
    }
  });

  it("rejects wrong response type and unsafe endpoint syntax without repeating secrets", async () => {
    expect(await failure(new DeepSeekBackend(config, async () => new Response(KEY)))).toMatchObject({ code: "protocol" });
    for (const baseURL of [`https://${KEY}@example.test`, `https://example.test/?key=${KEY}`, `file:///${KEY}`]) {
      let error: unknown;
      try { new ClaudeBackend({ ...config, baseURL }); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: "configuration" });
      expect(String(error)).not.toContain(KEY);
    }
  });
});

describe("cancellation and resource cleanup", () => {
  it.each([DeepSeekBackend, ClaudeBackend])("does not send a pre-cancelled request", async Backend => {
    const abort = new AbortController(); abort.abort();
    const fetcher = vi.fn<FetchLike>();
    const error = await failure(new Backend(config, fetcher), [], abort.signal);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cancels even if an injected transport is still waiting for headers", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn<FetchLike>(() => new Promise(() => {}));
    const iterator = new DeepSeekBackend(config, fetcher).generate(task, abort.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("cancels a waiting stream after partial text without producing done", async () => {
    const abort = new AbortController();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(deepText("部分"))); },
      cancel: cancelled,
    });
    const backend = new DeepSeekBackend(config, async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const iterator = backend.generate(task, abort.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "text", text: "部分" });
    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toHaveBeenCalledOnce();
    expect((await iterator.next()).done).toBe(true);
  });

  it("honors cancellation between usage and text in the same SSE frame", async () => {
    const abort = new AbortController();
    const backend = new DeepSeekBackend(config, async () => response(
      data({ choices: [{ delta: { content: "尚未发送" } }], usage: { prompt_tokens: 10 } }) + data("[DONE]"),
    ));
    const iterator = backend.generate(task, abort.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: "usage" });
    abort.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("disposes of a late transport response after cancellation", async () => {
    const abort = new AbortController();
    let respond!: (value: Response) => void;
    const cancelled = vi.fn();
    const backend = new DeepSeekBackend(config, () => new Promise(resolve => { respond = resolve; }));
    const iterator = backend.generate(task, abort.signal)[Symbol.asyncIterator]();
    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    respond(new Response(new ReadableStream({ cancel: cancelled })));
    await Promise.resolve();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it("cancels the stream when the caller stops consuming", async () => {
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(claudeStart() + claudeText("足够了"))); },
      cancel: cancelled,
    });
    const backend = new ClaudeBackend(config, async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    for await (const event of backend.generate(task, signal())) { expect(event.type).toBe("text"); break; }
    expect(cancelled).toHaveBeenCalledOnce();
  });
});
