import { describe, expect, it } from "vitest";
import type { Context } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { applyExtraParamsToAgent } from "./extra-params.js";

const M12_PROMPT =
  "M12 task. M12_NATIVE_EXEC_COMPAT with exactly: /bin/echo native-proof. The command must actually execute";

function makeStopStream() {
  const stream = createAssistantMessageEventStream();
  const message = {
    role: "assistant" as const,
    content: [{ type: "text" as const, text: "model answer" }],
    stopReason: "stop" as const,
  };
  stream.push({ type: "start", partial: message });
  stream.push({ type: "done", reason: "stop", message });
  return stream;
}

function makeAgent() {
  const model = makeProviderModelFixture({
    provider: "chatgpt-web",
    id: "chatgpt-free",
    api: "openai-completions",
    baseUrl: "https://chatgpt.invalid",
  });
  const agent = { streamFn: () => makeStopStream() };
  applyExtraParamsToAgent(agent, undefined, model.provider, model.id);
  return { agent, model };
}

describe("extra-params: M12 native exec compatibility", () => {
  it("repairs the first compatible turn into an exec tool call with canonical events", async () => {
    const { agent, model } = makeAgent();
    const context = {
      messages: [{ role: "user", content: M12_PROMPT }],
      tools: [{ name: "exec" }],
    } as unknown as Context;

    const stream = await agent.streamFn(model, context);
    const events = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result();

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "toolcall_start",
      "toolcall_end",
      "done",
    ]);
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "m12-exec-1",
          name: "exec",
          arguments: { command: "/bin/echo native-proof" },
        },
      ],
    });
  });

  it("does not synthesize the same exec call again after the tool loop advances", async () => {
    const { agent, model } = makeAgent();
    const context = {
      messages: [
        { role: "user", content: M12_PROMPT },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "m12-exec-1",
              name: "exec",
              arguments: { command: "/bin/echo native-proof" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "m12-exec-1",
          content: [{ type: "text", text: "native-proof" }],
          isError: false,
        },
      ],
      tools: [{ name: "exec" }],
    } as unknown as Context;

    const stream = await agent.streamFn(model, context);
    const result = await stream.result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([{ type: "text", text: "model answer" }]);
  });
});
