import { describe, it, expect } from "vitest";
import { remoteModelToInfo } from "../src/provider.js";

describe("remoteModelToInfo", () => {
  it("基础能力与 limit 映射", () => {
    const info: any = remoteModelToInfo({
      id: "m1", name: "M1", supportsToolCall: true, supportsImages: true,
      maxInputTokens: 1000, maxOutputTokens: 100, maxAllowedSize: 2000,
    });
    expect(info.id).toBe("m1");
    expect(info.modelID).toBe("m1");
    expect(info.name).toBe("M1");
    expect(info.capabilities.tools).toBe(true);
    expect(info.capabilities.input).toContain("image");
    expect(info.limit.context).toBe(2000);
    expect(info.limit.output).toBe(100);
    expect(info.compatibility.supportsPromptCacheKey).toBe(true);
  });

  it("reasoning：compatibility + variants 归一（medium→high、max 唯一高档）", () => {
    const info: any = remoteModelToInfo({
      id: "m2", name: "M2", supportsToolCall: true, supportsReasoning: true,
      reasoning: { supportedEfforts: ["low", "medium", "high", "xhigh", "max"] },
    });
    expect(info.compatibility.reasoningField).toBe("reasoning_content");
    expect(info.compatibility.requireReasoning).toBe(true);
    const ids = info.variants.map((v: any) => v.id);
    expect(ids).toEqual(["low", "medium", "high", "max"]);
    const byId = Object.fromEntries(info.variants.map((v: any) => [v.id, v.settings.reasoningEffort]));
    expect(byId.medium).toBe("medium");
    expect(byId.high).toBe("high");
    expect(byId.max).toBe("max");
  });

  it("无 images 时 input 不含 image", () => {
    const info: any = remoteModelToInfo({ id: "m3", name: "M3", supportsToolCall: true });
    expect(info.capabilities.input).not.toContain("image");
  });
});
