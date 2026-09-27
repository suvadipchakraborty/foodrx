/**
 * FoodRx — Cloudflare Worker
 *
 * Responsibilities:
 *   1. Serve the static site from /public (handled automatically by the
 *      `[assets]` binding configured in wrangler.toml — this file only
 *      needs to handle the dynamic API route below).
 *   2. POST /api/generate — take a list of medical conditions from the
 *      client, ask Gemini to act as a clinical dietitian, and return a
 *      strict JSON payload: { greenLight, redLight, explanation }.
 *
 * -----------------------------------------------------------------------
 * GEMINI_API_KEY
 * -----------------------------------------------------------------------
 * The Gemini API key is read from `env.GEMINI_API_KEY` below. It is never
 * hard-coded here. Set it as an encrypted Cloudflare secret with:
 *
 *     wrangler secret put GEMINI_API_KEY
 *
 * Cloudflare injects it into `env` at request time — it never touches the
 * client or the deployed bundle.
 * -----------------------------------------------------------------------
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = (model, key) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;

const MAX_CONDITIONS = 15;

const SYSTEM_INSTRUCTION = `You are a clinical dietitian producing concise, safe, general dietary guidance.
You will be given a list of medical conditions a person has been diagnosed with, together.
Your job is to reconcile the dietary rules for ALL of the listed conditions into ONE combined,
non-contradictory list — not separate lists per condition. Where the guidance for two conditions
conflicts (for example, a food that is fine for one condition but harmful for another), the food
must go on the "avoid" side, never both.

Respond with ONLY a JSON object matching this exact shape, and nothing else — no markdown fences,
no prose before or after it:

{
  "greenLight": ["food or food group", "..."],
  "redLight": ["food or food group", "..."],
  "explanation": "2-3 sentences in plain language describing how these conditions interact dietarily and how the list below resolves that overlap."
}

Rules:
- Provide 10-16 items in "greenLight" and 10-16 items in "redLight".
- Use short, plain food or food-group names a shopper would recognise (e.g. "Steamed leafy greens", not "Brassica oleracea").
- Never include a duplicate item across the two lists.
- Keep "explanation" factual, calm, and free of alarm.
- This is general educational guidance, not a prescription — do not include dosages, medication advice, or claims of certainty.`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate" && request.method === "POST") {
      return handleGenerate(request, env);
    }

    if (url.pathname === "/api/generate") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    // Everything else falls through to the static asset binding.
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleGenerate(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const conditions = Array.isArray(payload?.conditions)
    ? payload.conditions.filter((c) => typeof c === "string" && c.trim().length > 0).slice(0, MAX_CONDITIONS)
    : [];

  if (conditions.length === 0) {
    return jsonResponse({ error: "Select at least one condition." }, 400);
  }

  if (!env.GEMINI_API_KEY) {
    return jsonResponse(
      { error: "Server is not configured with a Gemini API key. Set GEMINI_API_KEY as a Cloudflare secret." },
      500
    );
  }

  const userPrompt = `Conditions: ${conditions.join(", ")}`;

  const geminiBody = {
    system_instruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature: 0.4,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          greenLight: { type: "ARRAY", items: { type: "STRING" } },
          redLight: { type: "ARRAY", items: { type: "STRING" } },
          explanation: { type: "STRING" },
        },
        required: ["greenLight", "redLight", "explanation"],
      },
    },
  };

  let geminiRes;
  try {
    geminiRes = await fetch(GEMINI_URL(GEMINI_MODEL, env.GEMINI_API_KEY), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(geminiBody),
    });
  } catch {
    return jsonResponse({ error: "Could not reach the AI service. Please try again." }, 502);
  }

  if (!geminiRes.ok) {
    const errText = await geminiRes.text().catch(() => "");
    console.error("Gemini error", geminiRes.status, errText);

    // Surface the real reason (truncated) so it's visible in the app's
    // error box without needing to check Worker logs separately.
    let detail = "";
    try {
      const parsedErr = JSON.parse(errText);
      detail = parsedErr?.error?.message || "";
    } catch {
      detail = errText;
    }
    detail = detail.slice(0, 200);

    return jsonResponse(
      {
        error: `AI service error (${geminiRes.status})${detail ? ": " + detail : ""}`,
      },
      502
    );
  }

  const geminiJson = await geminiRes.json().catch(() => null);
  const text = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    return jsonResponse({ error: "The AI service returned an unexpected response." }, 502);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return jsonResponse({ error: "Could not parse the generated list. Please try again." }, 502);
  }

  return jsonResponse({
    greenLight: parsed.greenLight ?? [],
    redLight: parsed.redLight ?? [],
    explanation: parsed.explanation ?? "",
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
