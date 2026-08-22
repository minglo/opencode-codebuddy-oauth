const FLUSH_RE = /[。！？.!?；;，,：:]$/;
// 尾部窗口：FLUSH_RE 只看最后 1 字符，扫描窗口截断避免全缓冲正则（长 reasoning/content 流 O(n²)）
const TAIL_WINDOW = 64;

function hasFlushTrigger(s: string): boolean {
  // 换行判定只需查最后一段（上次换行之后），避免每次全缓冲 includes 扫描
  const tail = s.length > TAIL_WINDOW ? s.slice(-TAIL_WINDOW) : s;
  return tail.includes("\n") || FLUSH_RE.test(tail.trimEnd());
}

// 统一输出格式：与阈值/标点触发（payload spread）一致，透传外层真实 payload，不伪造 id/object/created
// （v1 完整格式含伪造 id:"buffered" + created:Date.now()，定时 flush 路径与 spread 路径格式分裂）
// 无 payload 上下文时（流尾 flush）回退完整格式兜底
function flushBuf(
  controller: TransformStreamDefaultController<Uint8Array>,
  field: "reasoning_content" | "content",
  buf: string,
  payload?: Record<string, unknown>,
  first?: Record<string, unknown>,
): void {
  if (!buf) return;
  const out = payload && first
    ? { ...payload, choices:[{ ...first, delta:{ [field]: buf } }] }
    : { id:"buffered", object:"chat.completion.chunk", created: Date.now(), choices:[{ index:0, delta:{ [field]: buf }, finish_reason:null }] };
  controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(out)}\n`));
}

export function createSSEBufferedStream(
  body: ReadableStream<Uint8Array>,
  opts: { threshold:number; maxDelayMs:number },
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const threshold = opts.threshold;
  const maxDelay = opts.maxDelayMs;
  // 偏离设计 D5 明文"数组收集 join"：改用字符串拼接。V8 cons-string/sliced-string 下 += 与 slice 均摊销 O(1)，
  // 设计意图（修 leftover O(n²)，见设计文档 5.10/D5）达成且更简，属合理偏离（2026-08-22 审查定案）
  let pending = "";
  let reasoningBuf = "";
  let contentBuf = "";
  let reasoningTimer: ReturnType<typeof setTimeout> | null = null;
  let contentTimer: ReturnType<typeof setTimeout> | null = null;

  const clearReasoningTimer = () => { if (reasoningTimer) { clearTimeout(reasoningTimer); reasoningTimer = null; } };
  const clearContentTimer = () => { if (contentTimer) { clearTimeout(contentTimer); contentTimer = null; } };
  const flushAll = (controller: TransformStreamDefaultController<Uint8Array>, payload?: Record<string,unknown>, first?: Record<string,unknown>) => {
    if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf, payload, first); reasoningBuf = ""; clearReasoningTimer(); }
    if (contentBuf) { flushBuf(controller, "content", contentBuf, payload, first); contentBuf = ""; clearContentTimer(); }
  };

  const scheduleReasoningFlush = (ctrl: TransformStreamDefaultController<Uint8Array>, payload?: Record<string,unknown>, first?: Record<string,unknown>) => {
    if (reasoningTimer || !reasoningBuf) return;
    reasoningTimer = setTimeout(() => {
      try { flushBuf(ctrl, "reasoning_content", reasoningBuf, payload, first); } catch {}
      reasoningBuf = "";
      reasoningTimer = null;
    }, maxDelay);
  };
  const scheduleContentFlush = (ctrl: TransformStreamDefaultController<Uint8Array>, payload?: Record<string,unknown>, first?: Record<string,unknown>) => {
    if (contentTimer || !contentBuf) return;
    contentTimer = setTimeout(() => {
      try { flushBuf(ctrl, "content", contentBuf, payload, first); } catch {}
      contentBuf = "";
      contentTimer = null;
    }, maxDelay);
  };

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream:true });
      const nl = pending.lastIndexOf("\n");
      if (nl === -1) return;
      const complete = pending.slice(0, nl + 1);
      pending = pending.slice(nl + 1);
      const lines = complete.split("\n");
      if (lines[lines.length - 1] === "") lines.pop();
      // 最近真实 chunk 的外层上下文（payload/first），供 flushAll 与定时 flush 复用
      let lastPayload: Record<string, unknown> | undefined;
      let lastFirst: Record<string, unknown> | undefined;
      for (const line of lines) {
        const payloadStr = line.slice(6);
        // 非 data 行与 [DONE]：透传前先冲缓冲（带最近真实 payload 上下文；首个数据行前无上下文时兜底完整格式）
        if (!line.startsWith("data: ") || payloadStr.trim() === "[DONE]") {
          flushAll(controller, lastPayload, lastFirst);
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        let payload: Record<string,unknown>;
        try { payload = JSON.parse(payloadStr) as Record<string,unknown>; } catch {
          flushAll(controller, lastPayload, lastFirst);
          controller.enqueue(encoder.encode(line + "\n"));
          continue;
        }
        lastPayload = payload;
        const choices = (payload as any).choices as Array<any> | undefined;
        const first = choices?.[0];
        lastFirst = first;
        const delta = first?.delta as any;
        const finishReason = first?.finish_reason ?? first?.finishReason;
        const hasReasoning = typeof delta?.reasoning_content === "string" && delta.reasoning_content.length > 0;
        const hasReasoningAlt = typeof delta?.reasoning === "string" && delta.reasoning.length > 0;
        const hasContent = typeof delta?.content === "string" && delta.content.length > 0;
        const hasToolCalls = Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0;

        if ((hasReasoning || hasReasoningAlt) && !hasContent && !hasToolCalls && !finishReason) {
          const chunk = (delta?.reasoning_content ?? delta?.reasoning) as string;
          if (contentBuf) { flushBuf(controller, "content", contentBuf, lastPayload, lastFirst); contentBuf=""; clearContentTimer(); }
          reasoningBuf += chunk;
          if (reasoningBuf.length >= threshold || hasFlushTrigger(reasoningBuf)) {
            const out = { ...(payload as object), choices:[{ ...first, delta:{ reasoning_content: reasoningBuf } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n`));
            reasoningBuf=""; clearReasoningTimer();
          } else {
            scheduleReasoningFlush(controller, lastPayload, lastFirst);
          }
          continue;
        }
        if (hasContent && !hasReasoning && !hasReasoningAlt && !hasToolCalls && !finishReason) {
          if (reasoningBuf) { flushBuf(controller, "reasoning_content", reasoningBuf, lastPayload, lastFirst); reasoningBuf=""; clearReasoningTimer(); }
          contentBuf += delta.content as string;
          if (contentBuf.length >= threshold || hasFlushTrigger(contentBuf)) {
            const out = { ...(payload as object), choices:[{ ...first, delta:{ content: contentBuf } }] };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(out)}\n`));
            contentBuf=""; clearContentTimer();
          } else {
            scheduleContentFlush(controller, lastPayload, lastFirst);
          }
          continue;
        }
        flushAll(controller, lastPayload, lastFirst);
        controller.enqueue(encoder.encode(line + "\n"));
      }
    },
    flush(controller) {
      clearReasoningTimer(); clearContentTimer();
      if (reasoningBuf) flushBuf(controller, "reasoning_content", reasoningBuf);
      if (contentBuf) flushBuf(controller, "content", contentBuf);
      if (pending) controller.enqueue(encoder.encode(pending));
    },
  }));
}