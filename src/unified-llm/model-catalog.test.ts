import { describe, it, expect } from "vitest";
import { MODELS, getModelInfo, listModels, getLatestModel } from "./model-catalog.js";

describe("MODELS", () => {
  it("contains models from all three providers", () => {
    const providers = new Set(MODELS.map((m) => m.provider));
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("gemini");
  });

  it("all models have required fields", () => {
    for (const model of MODELS) {
      expect(model.id).toBeTruthy();
      expect(model.provider).toBeTruthy();
      expect(model.display_name).toBeTruthy();
      expect(model.context_window).toBeGreaterThan(0);
      expect(typeof model.supports_tools).toBe("boolean");
      expect(typeof model.supports_vision).toBe("boolean");
      expect(typeof model.supports_reasoning).toBe("boolean");
    }
  });
});

describe("getModelInfo()", () => {
  it("returns correct info for known model by ID", () => {
    const info = getModelInfo("claude-opus-4-6");
    expect(info).toBeDefined();
    expect(info!.provider).toBe("anthropic");
    expect(info!.display_name).toBe("Claude Opus 4.6");
    expect(info!.supports_tools).toBe(true);
    expect(info!.supports_reasoning).toBe(true);
  });

  it("returns correct info for model by alias", () => {
    const info = getModelInfo("opus");
    expect(info).toBeDefined();
    expect(info!.id).toBe("claude-opus-4-6");
  });

  it("returns correct info for OpenAI model", () => {
    const info = getModelInfo("gpt-5.2");
    expect(info).toBeDefined();
    expect(info!.provider).toBe("openai");
  });

  it("returns correct info for Gemini model", () => {
    const info = getModelInfo("gemini-3-flash-preview");
    expect(info).toBeDefined();
    expect(info!.provider).toBe("gemini");
  });

  it("resolves alias to same model as direct ID", () => {
    const byId = getModelInfo("claude-sonnet-4-5-20250929");
    const byAlias = getModelInfo("sonnet");
    expect(byId).toEqual(byAlias);
  });

  it("returns undefined for unknown model", () => {
    const info = getModelInfo("nonexistent-model-999");
    expect(info).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    const info = getModelInfo("");
    expect(info).toBeUndefined();
  });
});

describe("listModels()", () => {
  it("returns all models when no provider specified", () => {
    const all = listModels();
    expect(all.length).toBe(MODELS.length);
  });

  it("returns a copy (not the original array)", () => {
    const all = listModels();
    expect(all).not.toBe(MODELS);
    expect(all).toEqual(MODELS);
  });

  it("filters by provider", () => {
    const anthropicModels = listModels("anthropic");
    expect(anthropicModels.length).toBeGreaterThan(0);
    expect(anthropicModels.every((m) => m.provider === "anthropic")).toBe(true);
  });

  it("returns empty for unknown provider", () => {
    const models = listModels("nonexistent");
    expect(models).toHaveLength(0);
  });

  it("filters openai models correctly", () => {
    const openaiModels = listModels("openai");
    expect(openaiModels.length).toBeGreaterThan(0);
    expect(openaiModels.every((m) => m.provider === "openai")).toBe(true);
  });

  it("filters gemini models correctly", () => {
    const geminiModels = listModels("gemini");
    expect(geminiModels.length).toBeGreaterThan(0);
    expect(geminiModels.every((m) => m.provider === "gemini")).toBe(true);
  });
});

describe("getLatestModel()", () => {
  it("returns first anthropic model", () => {
    const model = getLatestModel("anthropic");
    expect(model).toBeDefined();
    expect(model!.provider).toBe("anthropic");
    expect(model!.id).toBe("claude-opus-4-6");
  });

  it("returns first openai model", () => {
    const model = getLatestModel("openai");
    expect(model).toBeDefined();
    expect(model!.provider).toBe("openai");
    expect(model!.id).toBe("gpt-5.2");
  });

  it("returns first gemini model", () => {
    const model = getLatestModel("gemini");
    expect(model).toBeDefined();
    expect(model!.provider).toBe("gemini");
  });

  it("filters by reasoning capability", () => {
    const model = getLatestModel("anthropic", "reasoning");
    expect(model).toBeDefined();
    expect(model!.supports_reasoning).toBe(true);
  });

  it("filters by vision capability", () => {
    const model = getLatestModel("openai", "vision");
    expect(model).toBeDefined();
    expect(model!.supports_vision).toBe(true);
  });

  it("filters by tools capability", () => {
    const model = getLatestModel("gemini", "tools");
    expect(model).toBeDefined();
    expect(model!.supports_tools).toBe(true);
  });

  it("returns undefined for unknown provider", () => {
    const model = getLatestModel("nonexistent");
    expect(model).toBeUndefined();
  });

  it("returns model without reasoning when haiku doesn't support it", () => {
    // Haiku doesn't support reasoning, so filtering anthropic by reasoning should skip it
    const model = getLatestModel("anthropic", "reasoning");
    expect(model).toBeDefined();
    expect(model!.id).not.toBe("claude-haiku-4-5-20251001");
  });
});
