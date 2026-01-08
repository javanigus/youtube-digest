import "dotenv/config";

export async function fetchTranscriptFromScrapingDog(videoId) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGDOG_API_KEY");

  const url = new URL("https://api.scrapingdog.com/youtube/transcripts");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("v", videoId);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: { "accept": "application/json" },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ScrapingDog error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();

  // Two cases you observed:
  // { transcripts: [ {text,start,duration,lang}, ... ] }
  // { transcripts: ["This video has no transcripts"] }
  const transcripts = data?.transcripts;

  if (!Array.isArray(transcripts) || transcripts.length === 0) {
    return { ok: false, reason: "no_transcript" };
  }

  if (transcripts.length === 1 && typeof transcripts[0] === "string") {
    return { ok: false, reason: "no_transcript" };
  }

  if (typeof transcripts[0] !== "object") {
    return { ok: false, reason: "no_transcript" };
  }

  const fullText = transcripts
    .map((seg) => seg?.text || "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  if (!fullText || fullText.length < 200) {
    return { ok: false, reason: "too_short" };
  }

  return {
    ok: true,
    text: decodeHtmlEntities(fullText),
    segments: transcripts.length,
    lang: transcripts[0]?.lang || null,
  };
}

// Minimal HTML entity decoding for common cases seen in transcripts
function decodeHtmlEntities(input) {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replace(/\s+/g, " ")
    .trim();
}
