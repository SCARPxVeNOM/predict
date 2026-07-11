import { config } from '../config.js';

/**
 * Tiny Gemini REST client (free tier). Returns the model's text, or null when
 * no key is configured / the call fails — callers must always have a
 * deterministic fallback, the platform never depends on the LLM being up.
 */
async function callModel(model: string, prompt: string): Promise<{ text: string | null; status: number }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
          // 2.5-series models think by default; spend the budget on output.
          ...(model.includes('2.5') ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    },
  );
  if (!res.ok) {
    console.error(`[gemini] ${model} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return { text: null, status: res.status };
  }
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return { text: body.candidates?.[0]?.content?.parts?.[0]?.text ?? null, status: 200 };
}

export async function geminiGenerate(prompt: string): Promise<string | null> {
  if (!config.geminiApiKey) return null;
  try {
    const primary = await callModel(config.geminiModel, prompt);
    if (primary.status !== 429) return primary.text;
    // Free-tier quotas are PER MODEL — when the primary bucket is exhausted,
    // fall back to the lite model's separate bucket.
    if (config.geminiModelFallback && config.geminiModelFallback !== config.geminiModel) {
      const fallback = await callModel(config.geminiModelFallback, prompt);
      return fallback.text;
    }
    return null;
  } catch (err) {
    console.error('[gemini] request failed:', String(err).slice(0, 200));
    return null;
  }
}
