// Cloudflare Worker: Coffee Assistant API Proxy
// Routes:
//   POST /scan            — reads a coffee bag photo and extracts bean details
//   POST /generate-recipe — generates a Hoffmann Clever Dripper recipe for a bean
//   POST /analyze-brew    — analyzes tasting notes and recommends adjustments
//
// All routes proxy to Anthropic, keep the API key secret, and add CORS headers.

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";

// ── Prompts ────────────────────────────────────────────────────────────────────

const SCAN_PROMPT = `You are a coffee expert analyzing a photo of a coffee bag. Extract details from the label with high accuracy.

ROAST LEVEL — this is the most important field. Follow this priority order strictly:

1. EXPLICIT TEXT LABEL — if the bag says "Dark Roast", "Light Roast", "Medium Roast", "Medium Dark Roast", or any clear roast name, use that. This overrides everything else. A bag that says "Dark Roast" in text is ALWAYS dark, no matter what a slider graphic looks like.

2. ROAST SPECTRUM GRAPHIC — if there is a slider, dial, or spectrum graphic, note where the indicator sits:
   - Rightmost 25% of scale = dark
   - Right-center = medium-dark
   - Center = medium
   - Left-center = light-medium
   - Leftmost 25% = light

3. ROAST DEGREE NAMES — e.g. "French Roast" = dark, "Full City" = medium-dark, "City Roast" = medium, "City+" = medium-dark

If explicit text says "Dark Roast", return "dark". Do not second-guess it.
Do NOT default to medium unless there is genuinely zero roast information visible anywhere on the bag.

Respond ONLY with a JSON object, no markdown, no backticks, no preamble:
{
  "name": "Coffee name and/or roaster name",
  "roastLevel": "one of exactly: light, light-medium, medium, medium-dark, dark",
  "origin": "Country or region of origin, plus any tasting/flavor notes on the bag",
  "roastDate": "ISO date string YYYY-MM-DD if visible, otherwise null"
}
Always return valid JSON.`;

function buildRecipePrompt(bean) {
  const daysOld = bean.roastDate
    ? Math.floor((Date.now() - new Date(bean.roastDate)) / 864e5)
    : null;
  const freshnessNote = daysOld !== null
    ? `Roasted ${daysOld} day${daysOld !== 1 ? "s" : ""} ago.`
    : "Roast date unknown.";

  return `You are a precise coffee dialing assistant. Generate a starting Hoffmann Method recipe for a Clever Dripper using an Oxo Brew Conical Burr Grinder.

Bean details:
- Name: ${bean.name}
- Roast level: ${bean.roastLevel}
- Origin / flavor notes: ${bean.origin || "not specified"}
- ${freshnessNote}

GRINDER: The Oxo Brew Conical Burr Grinder has discrete 1/3-step increments. Valid settings are ONLY:
1, 1.33, 1.67, 2, 2.33, 2.67, 3, 3.33, 3.67, 4, 4.33, 4.67, 5, 5.33, 5.67, 6, 6.33, 6.67, 7, 7.33, 7.67, 8, 8.33, 8.67, 9, 9.33, 9.67, 10, 10.33, 10.67, 11, 11.33, 11.67, 12, 12.33, 12.67, 13, 13.33, 13.67, 14, 14.33, 14.67, 15
You MUST pick one of these exact values. Do not return any other number.

GRIND RANGES BY ROAST LEVEL — use these as your starting point anchors:
- light: 6.67–7.67 (finer to maximize extraction of harder, denser beans)
- light-medium: 7.33–8.33
- medium: 8.00–9.00
- medium-dark: 8.67–9.67
- dark: 9.33–10.33 (coarser to prevent over-extraction and bitterness of oily, soluble beans)
Pick within the appropriate range. Do not recommend a grind below the range for a given roast level.

TEMPERATURE: Always return exactly "just off boil (205-212°F / 96-100°C)" for all beans. Temperature is fixed in the Hoffmann Clever Dripper method and does not vary by roast level.

STEEP TIME: The Hoffmann method default is exactly 2:00 (steepMin: 2.0). Steep time is the most forgiving variable in this method — only deviate with a specific, bean-driven reason (e.g. very fresh beans <7 days old with high CO2 may warrant 2.33). Valid steepMin values follow the same 1/3-step pattern: 1.67, 2.0, 2.33, etc. Stick to 2.0 unless you have a compelling reason tied to this specific bean.

RATIO: Recommend a brew ratio in grams of coffee per liter of water (g/L). Hoffmann's range for the Clever Dripper is 60–75 g/L, with his current preference at the lower end (60–65 g/L). Return an integer. For example, 62 means 62g coffee per 1000g water. Consider roast level and origin — lighter roasts with higher density can handle slightly higher ratios; darker roasts are often better at the lower end.

Consider the roast level, origin, processing style if inferable, and bean freshness (very fresh beans <7 days may warrant a slightly coarser grind to manage CO2).

Respond ONLY with a JSON object, no markdown, no backticks, no preamble:
{
  "grindSetting": <must be one of the exact valid values listed above>,
  "grindNote": "brief note explaining the grind choice",
  "tempRec": "just off boil (205-212°F / 96-100°C)",
  "steepMin": <2.0 unless there is a specific bean-driven reason to deviate, must be a valid 1/3-step value>,
  "ratio": <integer, grams of coffee per liter of water, 60–75 range>,
  "recipeNote": "1–2 sentence plain English rationale for these settings given this specific bean"
}`;
}

function buildBrewAnalysisPrompt(bean, ratio, notes, drainTimeSec) {
  const brewHistory = bean.brewLogs && bean.brewLogs.length > 0
    ? bean.brewLogs.slice(-4).map(l =>
        `- ${new Date(l.date).toLocaleDateString()}: grind ${l.grindUsed}, ratio ${l.ratio}, notes: "${l.notes}"${l.drainTimeSec != null ? `, drain ${l.drainTimeSec}s` : ''}`
      ).join("\n")
    : "No previous brews logged.";

  const ratioDisplay = bean.ratio ? `${bean.ratio} g/L (AI-generated for this bean)` : ratio;

  const drainNote = drainTimeSec != null
    ? `Drain time this brew: ${drainTimeSec}s (target range for a well-dialed Clever Dripper is 35–55s; under 35s suggests grind may be too coarse, over 60s suggests grind may be too fine)`
    : "Drain time: not recorded";

  return `You are a precise coffee dialing assistant helping a home barista refine their Clever Dripper brews using the Hoffmann method.

Bean: ${bean.name}
Roast level: ${bean.roastLevel}
Origin / flavor notes: ${bean.origin || "not specified"}
Current Oxo grinder setting: ${bean.grindSetting} (scale 1–15, higher = coarser)
Water temp: just off boil (205-212°F / 96-100°C) — this is fixed, do not suggest temp changes
Steep time: ${bean.steepMin} min
Brew ratio: ${ratioDisplay}
Ratio used this brew: ${ratio}
${drainNote}

Recent brew history for context:
${brewHistory}

Tasting notes from this brew: "${notes}"

GRINDER: The Oxo Brew Conical Burr Grinder has discrete 1/3-step increments. Valid settings are ONLY:
1, 1.33, 1.67, 2, 2.33, 2.67, 3, 3.33, 3.67, 4, 4.33, 4.67, 5, 5.33, 5.67, 6, 6.33, 6.67, 7, 7.33, 7.67, 8, 8.33, 8.67, 9, 9.33, 9.67, 10, 10.33, 10.67, 11, 11.33, 11.67, 12, 12.33, 12.67, 13, 13.33, 13.67, 14, 14.33, 14.67, 15
newGrind MUST be one of these exact values or null. Do not return any other number.
Move at minimum one full step (0.33) from the current setting when recommending a change — smaller adjustments are not physically possible.

IMPORTANT: Temperature is fixed at just off boil for this method. Do not recommend temperature changes. Set tempAdjust to null always.

Analyze the tasting notes holistically — consider the bean's origin, roast level, the brew history trend, and any nuance in the description. Do not just pattern-match on keywords.

Respond ONLY with a valid JSON object, no markdown, no backticks, no preamble:
{
  "diagnosis": "1–2 sentence plain English diagnosis of what's happening with this brew",
  "grindDirection": "finer" or "coarser" or "none",
  "newGrind": <must be one of the exact valid values listed above, or null if no change recommended>,
  "grindConfidence": <integer 0–100, your confidence in the grind recommendation>,
  "tempAdjust": null,
  "timeAdjust": "<steep time suggestion, or null>",
  "rationale": "1–2 sentences explaining the reasoning, referencing the bean, drain time if available, and history if relevant",
  "keepSetting": <true only if the brew was clearly well-extracted and no changes needed>
}`;
}

// ── Route handlers ─────────────────────────────────────────────────────────────

// Snap any grind value to the nearest valid Oxo 1/3-step increment
function snapToGrindStep(value) {
  if (value === null || value === undefined) return null;
  const v = Math.max(1, Math.min(15, parseFloat(value)));
  const steps = Math.round((v - 1) * 3);
  return Math.round((1 + steps / 3) * 100) / 100;
}

async function handleScan(body, env) {
  if (!body.image || !body.media_type) {
    return jsonError("Missing image or media_type", 400, env);
  }

  const anthropicBody = {
    model: MODEL,
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: body.media_type, data: body.image },
        },
        { type: "text", text: SCAN_PROMPT },
      ],
    }],
  };

  return callAnthropic(anthropicBody, env);
}

async function handleGenerateRecipe(body, env) {
  if (!body.bean) {
    return jsonError("Missing bean object", 400, env);
  }

  const anthropicBody = {
    model: MODEL,
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: buildRecipePrompt(body.bean),
    }],
  };

  const response = await callAnthropic(anthropicBody, env);
  // Snap grindSetting to valid increment; clamp ratio to valid range before returning
  if (response.status === 200) {
    const data = await response.json();
    data.grindSetting = snapToGrindStep(data.grindSetting);
    if (typeof data.ratio !== "number" || data.ratio < 60 || data.ratio > 75) {
      data.ratio = 62;
    } else {
      data.ratio = Math.round(data.ratio);
    }
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders(env), "Content-Type": "application/json" },
    });
  }
  return response;
}

async function handleAnalyzeBrew(body, env) {
  if (!body.bean || !body.notes || !body.ratio) {
    return jsonError("Missing bean, notes, or ratio", 400, env);
  }

  const drainTimeSec = (typeof body.drainTimeSec === 'number') ? body.drainTimeSec : null;

  const anthropicBody = {
    model: MODEL,
    max_tokens: 1000,
    messages: [{
      role: "user",
      content: buildBrewAnalysisPrompt(body.bean, body.ratio, body.notes, drainTimeSec),
    }],
  };

  const response = await callAnthropic(anthropicBody, env);
  // Snap newGrind to valid increment; force tempAdjust null before returning
  if (response.status === 200) {
    const data = await response.json();
    if (data.newGrind !== null && data.newGrind !== undefined) {
      data.newGrind = snapToGrindStep(data.newGrind);
    }
    data.tempAdjust = null;
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders(env), "Content-Type": "application/json" },
    });
  }
  return response;
}

// ── Shared Anthropic caller ────────────────────────────────────────────────────

async function callAnthropic(anthropicBody, env) {
  const apiResponse = await fetch(ANTHROPIC_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(anthropicBody),
  });

  const data = await apiResponse.json();

  if (!data.content) {
    return jsonError("Unexpected API response", 502, env, data);
  }

  const text = data.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("");

  const clean = text.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    return new Response(JSON.stringify(parsed), {
      headers: { ...corsHeaders(env), "Content-Type": "application/json" },
    });
  } catch {
    return jsonError("Failed to parse AI response", 502, env, { raw: clean });
  }
}

// ── Main fetch handler ─────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(env) });
    }

    if (request.method !== "POST") {
      return jsonError("Method not allowed", 405, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonError("Invalid JSON body", 400, env);
    }

    try {
      if (path === "/scan") return await handleScan(body, env);
      if (path === "/generate-recipe") return await handleGenerateRecipe(body, env);
      if (path === "/analyze-brew") return await handleAnalyzeBrew(body, env);
      return jsonError("Not found", 404, env);
    } catch (err) {
      return jsonError(err.message, 500, env);
    }
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function corsHeaders(env) {
  // Lock this down to your GitHub Pages URL in production:
  // Set ALLOWED_ORIGIN secret in Cloudflare dashboard e.g. "https://yourusername.github.io"
  const origin = env.ALLOWED_ORIGIN || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Client-Token",
    "Access-Control-Max-Age": "86400",
  };
}

function jsonError(message, status, env, extra = {}) {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { ...corsHeaders(env), "Content-Type": "application/json" },
  });
}
