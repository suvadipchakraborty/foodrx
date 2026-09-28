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

// Tried in order. If a model keeps failing (overloaded / unavailable), the
// next one is used. Override with a comma-separated GEMINI_MODELS variable
// in wrangler.toml [vars] or the dashboard if you want different models.
const DEFAULT_MODELS = ["gemini-3.8-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite"];

const ATTEMPTS_PER_MODEL = 3;
const BASE_DELAY_MS = 600; // 600ms, 1.2s, (2.4s) + jitter
const MAX_RETRY_AFTER_MS = 4000;
const TOTAL_BUDGET_MS = 25000; // stop retrying after this long overall
const REQUEST_TIMEOUT_MS = 12000; // per Gemini call
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
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

  const models = getModels(env);
  const result = await callGeminiWithFallback(models, env.GEMINI_API_KEY, geminiBody);

  if (!result.ok) {
    console.error("Gemini failed", JSON.stringify(result.log));
    return jsonResponse({ error: result.message, retryable: result.retryable }, result.httpStatus);
  }

  return jsonResponse({
    greenLight: Array.isArray(result.data.greenLight) ? result.data.greenLight : [],
    redLight: Array.isArray(result.data.redLight) ? result.data.redLight : [],
    explanation: typeof result.data.explanation === "string" ? result.data.explanation : "",
  });
}

function getModels(env) {
  const fromEnv = (env.GEMINI_MODELS || "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_MODELS;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function backoffDelay(attempt, retryAfterHeader) {
  const retryAfterSec = Number(retryAfterHeader);
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
  }
  const exp = BASE_DELAY_MS * 2 ** attempt;
  return exp + Math.random() * 300; // jitter avoids synchronized retries
}

// Extract and validate the model's JSON. Returns object or null.
function parseGeminiPayload(geminiJson) {
  const parts = geminiJson?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p) => typeof p?.text === "string" && !p.thought)
    .map((p) => p.text)
    .join("")
    .trim();
  if (!text) return null;
  try {
    const obj = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (!Array.isArray(obj?.greenLight) || !Array.isArray(obj?.redLight)) return null;
    if (obj.greenLight.length === 0 && obj.redLight.length === 0) return null;
    return obj;
  } catch {
    return null;
  }
}

async function callGeminiWithFallback(models, apiKey, body) {
  const started = Date.now();
  const log = [];
  let lastKind = "unavailable"; // "unavailable" | "bad_response" | "config"

  for (const model of models) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      if (Date.now() - started > TOTAL_BUDGET_MS) {
        return failure(lastKind, log);
      }

      let res;
      try {
        res = await fetch(GEMINI_URL(model, apiKey), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        // Network error or timeout: transient, retry.
        log.push({ model, attempt, error: String(err?.name || err) });
        lastKind = "unavailable";
        if (attempt < ATTEMPTS_PER_MODEL - 1) await sleep(backoffDelay(attempt));
        continue;
      }

      if (res.ok) {
        const json = await res.json().catch(() => null);
        const data = parseGeminiPayload(json);
        if (data) return { ok: true, data, model };
        // Empty / malformed / blocked output: retry, it is often a one-off.
        log.push({ model, attempt, status: 200, error: "unusable_response", finishReason: json?.candidates?.[0]?.finishReason });
        lastKind = "bad_response";
        if (attempt < ATTEMPTS_PER_MODEL - 1) await sleep(backoffDelay(attempt));
        continue;
      }

      const errText = await res.text().catch(() => "");
      log.push({ model, attempt, status: res.status, body: errText.slice(0, 300) });

      if (RETRYABLE_STATUS.has(res.status)) {
        lastKind = "unavailable";
        if (attempt < ATTEMPTS_PER_MODEL - 1) {
          await sleep(backoffDelay(attempt, res.headers.get("Retry-After")));
          continue;
        }
        break; // out of attempts for this model, try the next one
      }

      if (res.status === 404) {
        // Model name doesn't exist for this key: skip straight to the next model.
        lastKind = "unavailable";
        break;
      }

      // 400 / 401 / 403 etc: our request or key is wrong. Retrying or switching
      // models will not help, so fail fast and keep details in logs only.
      return failure("config", log);
    }
  }

  return failure(lastKind, log);
}

function failure(kind, log) {
  if (kind === "config") {
    return {
      ok: false,
      httpStatus: 500,
      retryable: false,
      message: "The AI service is not set up correctly. Please contact the site owner.",
      log,
    };
  }
  if (kind === "bad_response") {
    return {
      ok: false,
      httpStatus: 502,
      retryable: true,
      message: "The AI returned an unusable answer. Please tap Generate again.",
      log,
    };
  }
  return {
    ok: false,
    httpStatus: 503,
    retryable: true,
    message: "The AI is very busy right now. We tried several times, so please try again in a minute.",
    log,
  };
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
