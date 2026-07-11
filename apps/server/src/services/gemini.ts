import { config } from '../config.js';

/**
 * Tiny Gemini REST client (free tier). Returns the model's text, or null when
 * no key is configured / the call fails — callers must always have a
 * deterministic fallback, the platform never depends on the LLM being up.
 */
async function callModel(
  model: string,
  apiKey: string,
  prompt: string,
): Promise<{ text: string | null; status: number }> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
    console.error(
      `[gemini] ${model} (key …${apiKey.slice(-6)}) ${res.status}: ${(await res.text()).slice(0, 150)}`,
    );
    return { text: null, status: res.status };
  }
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return { text: body.candidates?.[0]?.content?.parts?.[0]?.text ?? null, status: 200 };
}

// Rotation cursor: start each request from the last bucket that worked so a
// healthy bucket is hit first instead of burning 429s down the whole list.
let cursor = 0;

export async function geminiGenerate(prompt: string): Promise<string | null> {
  const keys = config.geminiApiKeys;
  if (!keys.length) return null;
  const models = [
    config.geminiModel,
    ...(config.geminiModelFallback && config.geminiModelFallback !== config.geminiModel
      ? [config.geminiModelFallback]
      : []),
  ];
  // Buckets = every key × model combination (free-tier quota is per key AND
  // per model). Try each once; 429 moves on, anything else is final.
  const buckets: { key: string; model: string }[] = [];
  for (const model of models) for (const key of keys) buckets.push({ key, model });

  try {
    for (let i = 0; i < buckets.length; i++) {
      const b = buckets[(cursor + i) % buckets.length]!;
      const res = await callModel(b.model, b.key, prompt);
      if (res.status !== 429) {
        cursor = (cursor + i) % buckets.length;
        return res.text;
      }
    }
    console.error('[gemini] every key/model bucket is rate-limited');
    return null;
  } catch (err) {
    console.error('[gemini] request failed:', String(err).slice(0, 200));
    return null;
  }
}
