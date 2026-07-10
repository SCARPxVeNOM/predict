import { config } from '../config.js';

/**
 * Tiny Gemini REST client (free tier). Returns the model's text, or null when
 * no key is configured / the call fails — callers must always have a
 * deterministic fallback, the platform never depends on the LLM being up.
 */
export async function geminiGenerate(prompt: string): Promise<string | null> {
  if (!config.geminiApiKey) return null;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiModel}:generateContent?key=${config.geminiApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
          },
        }),
      },
    );
    if (!res.ok) {
      console.error(`[gemini] ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return null;
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return body.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  } catch (err) {
    console.error('[gemini] request failed:', String(err).slice(0, 200));
    return null;
  }
}
