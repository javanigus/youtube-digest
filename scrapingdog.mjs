import "dotenv/config";

/**
 * ScrapingDog YouTube Transcript fetch with retry + non-fatal failures.
 *
 * Returns:
 *  - { ok: true, text, segments, lang }
 *  - { ok: false, reason }
 *
 * NOTE: Only throws for missing SCRAPINGDOG_API_KEY (developer/config error).
 */
export async function fetchTranscriptFromScrapingDog(videoId) {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) throw new Error("Missing SCRAPINGDOG_API_KEY");

  const url = new URL("https://api.scrapingdog.com/youtube/transcripts");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("v", videoId);

  const maxAttempts = Number(process.env.SCRAPINGDOG_MAX_ATTEMPTS || 3); // 3 total tries
  const baseDelayMs = Number(process.env.SCRAPINGDOG_BASE_DELAY_MS || 800); // backoff base

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: { accept: "application/json" },
      });

      // Non-200: decide retry vs return a clean failure
      if (!res.ok) {
        const status = res.status;
        const bodyText = await safeReadText(res);

        // Retry on transient errors
        if (isTransientHttp(status) && attempt < maxAttempts) {
          await sleep(backoffDelay(baseDelayMs, attempt));
          continue;
        }

        // Permanent (or last attempt): return non-fatal result
        return {
          ok: false,
          reason: formatProviderError("scrapingdog", status, bodyText),
        };
      }

      // OK response: parse JSON (or fail gracefully if not JSON)
      const data = await safeReadJson(res);
      if (!data) {
        // Sometimes providers return HTML despite 200, or empty body.
        // Retry once or return a clean failure.
        if (attempt < maxAttempts) {
          await sleep(backoffDelay(baseDelayMs, attempt));
          continue;
        }
        return { ok: false, reason: "scrapingdog_invalid_json" };
      }

      const transcripts = data?.transcripts;

      // Two cases you observed:
      // { transcripts: [ {text,start,duration,lang}, ... ] }
      // { transcripts: ["This video has no transcripts"] }
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
    } catch (err) {
      // Network / fetch errors: retry a couple times, then return clean failure
      if (attempt < maxAttempts) {
        await sleep(backoffDelay(baseDelayMs, attempt));
        continue;
      }
      return { ok: false, reason: `scrapingdog_fetch_error:${safeErrMsg(err)}` };
    }
  }

  // Should never reach here, but keep it safe.
  return { ok: false, reason: "scrapingdog_unknown_error" };
}

function isTransientHttp(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function backoffDelay(baseMs, attempt) {
  // exponential backoff with jitter, capped
  const exp = Math.min(baseMs * Math.pow(2, attempt - 1), 8000);
  const jitter = Math.floor(Math.random() * 250);
  return exp + jitter;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeReadText(res) {
  try {
    const t = await res.text();
    return (t || "").slice(0, 300);
  } catch {
    return "";
  }
}

async function safeReadJson(res) {
  try {
    return await res.json();
  } catch {
    // If it isn't JSON, try to read some text for debugging (but don't throw)
    return null;
  }
}

function formatProviderError(provider, status, bodyText) {
  // Keep it short & stable for email + logs
  // Detect HTML (common for 502 pages)
  const looksHtml = /<!doctype html>|<html/i.test(bodyText || "");
  if (looksHtml) return `${provider}_http_${status}`;
  if (!bodyText) return `${provider}_http_${status}`;
  return `${provider}_http_${status}:${bodyText.replace(/\s+/g, " ").slice(0, 120)}`;
}

function safeErrMsg(err) {
  const msg = err?.message || String(err);
  return msg.replace(/\s+/g, " ").slice(0, 200);
}

// Minimal HTML entity decoding for common cases seen in transcripts
function decodeHtmlEntities(input) {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&#39;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&gt;", ">")
    .replace(/\s+/g, " ")
    .trim();
}
