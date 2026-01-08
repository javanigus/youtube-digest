import "dotenv/config";

/**
 * Summarize a transcript into neutral structured JSON:
 * {
 *   one_liner: string,
 *   key_points: string[],
 *   who_should_watch: string
 * }
 *
 * Uses Structured Outputs (json_schema + strict) to guarantee valid JSON.
 */
export async function summarizeTranscript({
  title,
  channelName,
  transcriptText,
  maxBullets = 5,
}) {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

  // Cost control
  const clipped = String(transcriptText || "").slice(0, 18000);

  const system =
    "You write neutral, factual summaries of YouTube videos. " +
    "No opinions. No persuasion. No speculation. No snark. " +
    "Follow the schema exactly.";

  const user = `Summarize this video based on the transcript.

Video title: ${title}
Channel: ${channelName}

Transcript:
${clipped}
`;

  // Structured Outputs schema (strict)
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["one_liner", "key_points", "who_should_watch"],
    properties: {
      one_liner: { type: "string", description: "One-sentence neutral summary." },
      key_points: {
        type: "array",
        description: "Key factual points from the video.",
        items: { type: "string" },
      },
      who_should_watch: { type: "string", description: "Who would find this useful." },
    },
  };

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      // ✅ Structured Outputs (guaranteed JSON + schema adherence)
      text: {
        format: {
          type: "json_schema",
          name: "video_summary",
          strict: true,
          schema,
        },
      },
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return {
      one_liner: "Summary unavailable (OpenAI API error).",
      key_points: [],
      who_should_watch: `API error: ${resp.status} ${text.slice(0, 120)}`.trim(),
    };
  }

  const data = await resp.json();

  // Extract model output text from Responses API payload
  const out = extractResponseText(data).trim();
  if (!out) {
    return {
      one_liner: "Summary unavailable (empty model output).",
      key_points: [],
      who_should_watch: "Video overview unavailable due to an API output issue.",
    };
  }

  // With json_schema+strict, this should parse. Still guard defensively.
  const parsed = safeJsonParse(out);
  if (!parsed) {
    return {
      one_liner: "Summary unavailable (unexpected output format).",
      key_points: [],
      who_should_watch: "Video overview unavailable due to a formatting issue.",
    };
  }

  return normalizeSummary(parsed, maxBullets);
}

/**
 * Responses API note:
 * output_text is SDK-only convenience. When using raw fetch, read output[] items.
 */
function extractResponseText(data) {
  const chunks = [];

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    if (item?.type === "message" && Array.isArray(item?.content)) {
      for (const c of item.content) {
        if (c?.type === "output_text" && typeof c?.text === "string") {
          chunks.push(c.text);
        } else if (c?.type === "text" && typeof c?.text === "string") {
          chunks.push(c.text);
        } else if (typeof c?.text === "string") {
          chunks.push(c.text);
        }
      }
    }
  }

  // If present, include it (but don't rely on it)
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    chunks.push(data.output_text);
  }

  return chunks.join("\n").trim();
}

function safeJsonParse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // In theory strict schema prevents this, but keep guard anyway
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch {}
    }
    return null;
  }
}

function normalizeSummary(obj, maxBullets) {
  const one_liner = String(obj?.one_liner || "").trim();
  const key_points = Array.isArray(obj?.key_points) ? obj.key_points : [];
  const who_should_watch = String(obj?.who_should_watch || "").trim();

  return {
    one_liner: (one_liner || "Summary unavailable.").slice(0, 220),
    key_points: key_points
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, maxBullets),
    who_should_watch: (who_should_watch || "Anyone who wants a neutral overview.")
      .slice(0, 180),
  };
}
