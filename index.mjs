import "dotenv/config";
import { CHANNEL_PACKS } from "./channels.mjs";
import { fetchTranscriptFromScrapingDog } from "./scrapingdog.mjs";
import { summarizeTranscript } from "./openai_summarize.mjs";
import { buildEmail, sendEmail } from "./email.mjs";

function getCapPerSection() {
  const freq = (process.env.DIGEST_FREQUENCY || "daily").toLowerCase();
  if (freq === "weekly") return Number(process.env.CAP_WEEKLY_PER_SECTION || 15);
  return Number(process.env.CAP_DAILY_PER_SECTION || 7);
}

const FREQUENCY = (process.env.DIGEST_FREQUENCY || "daily").toLowerCase();
const TIMEZONE = process.env.TIMEZONE || "America/Los_Angeles";
const MAX_VIDEOS_PER_CHANNEL = Number(process.env.MAX_VIDEOS_PER_CHANNEL || 3);

const MAX_AGE_DAYS_DAILY = Number(process.env.MAX_AGE_DAYS_DAILY || 2);
const MAX_AGE_DAYS_WEEKLY = Number(process.env.MAX_AGE_DAYS_WEEKLY || 9);

function getMaxAgeDays() {
  return FREQUENCY === "weekly" ? MAX_AGE_DAYS_WEEKLY : MAX_AGE_DAYS_DAILY;
}

function isWithinMaxAge(publishedAtIso) {
  const maxAgeDays = getMaxAgeDays();
  const publishedMs = Date.parse(publishedAtIso);
  if (!Number.isFinite(publishedMs)) return false;

  const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  return publishedMs >= cutoffMs;
}

async function fetchLatestVideosFromChannelUrl(channelUrl) {
  // Phase 1 simplification:
  // Use the channel's RSS feed (no YouTube API key needed).
  // It’s reliable enough for a PoC.
  //
  // RSS format:
  // https://www.youtube.com/feeds/videos.xml?channel_id=...
  //
  // But we only have channel URLs (@handle). We'll convert handle -> RSS by resolving channel page -> channelId.
  const channelId = await resolveChannelId(channelUrl);
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  const res = await fetch(rssUrl);
  if (!res.ok) throw new Error(`RSS fetch failed: ${channelUrl}`);

  const xml = await res.text();
  return parseYouTubeRss(xml).slice(0, MAX_VIDEOS_PER_CHANNEL);
}

async function resolveChannelId(channelUrl) {
  // Fetch the channel page HTML and extract channel_id from canonical / meta.
  // Keeps Phase 1 simple without Google API keys.
  const res = await fetch(channelUrl, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`Channel page fetch failed: ${channelUrl}`);
  const html = await res.text();

  // Common patterns:
  // "channelId":"UCxxxx"
  // https://www.youtube.com/channel/UCxxxx
  const m1 = html.match(/"channelId":"(UC[a-zA-Z0-9_-]{20,})"/);
  if (m1?.[1]) return m1[1];

  const m2 = html.match(/https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{20,})/);
  if (m2?.[1]) return m2[1];

  throw new Error(`Could not resolve channel_id for ${channelUrl}`);
}

function parseYouTubeRss(xml) {
  // Minimal RSS parsing (no extra deps)
  // Extract: title, link, published
  const entries = [];
  const entryBlocks = xml.split("<entry>").slice(1);
  for (const block of entryBlocks) {
    const title = extractXml(block, "title");
    const link = (block.match(/<link[^>]*href="([^"]+)"/) || [])[1];
    const published = extractXml(block, "published");
    const videoId = (link || "").split("v=")[1]?.split("&")[0];

    if (title && link && published && videoId) {
      entries.push({
        title: decodeXml(title),
        url: link,
        videoId,
        publishedAt: published,
      });
    }
  }
  // Most recent first
  entries.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));
  return entries;
}

function extractXml(block, tag) {
  const m = block.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m?.[1]?.trim() || null;
}
function decodeXml(s) {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

async function run() {
  const cap = getCapPerSection();

  const sectionsOut = [];

  for (const packKey of Object.keys(CHANNEL_PACKS)) {
    const pack = CHANNEL_PACKS[packKey];
    const allVideos = [];

    // Pull videos from each channel in the pack
    for (const ch of pack.channels) {
      if (!ch.url || ch.url.startsWith("PASTE_")) continue;

      try {
        const vids = await fetchLatestVideosFromChannelUrl(ch.url);

        // ✅ Filter out old videos (prevents random 2012 stuff)
        const fresh = vids.filter((v) => isWithinMaxAge(v.publishedAt));

        fresh.forEach((v) => allVideos.push({ ...v, channelName: ch.name }));
      } catch (e) {
        // If a channel fails, we just skip it in Phase 1
        // (Later: log / alert)
      }
    }

    // Deduplicate by videoId (some feeds can overlap)
    const dedup = new Map();
    for (const v of allVideos) dedup.set(v.videoId, v);
    const videos = Array.from(dedup.values()).sort((a, b) =>
      a.publishedAt < b.publishedAt ? 1 : -1
    );

    const summarizedItems = [];
    const skippedItems = [];

    for (const v of videos) {
      // Stop once we’ve built enough items to *display*.
      // We still want accurate counts though, so we’ll keep scanning a bit.
      // Phase 1: scan all collected per-channel videos (small).
      const t = await fetchTranscriptFromScrapingDog(v.videoId);

      if (!t.ok) {
        skippedItems.push({
          status: "skipped",
          reason:
            t.reason === "no_transcript"
              ? "This video has no transcript/captions available on YouTube."
              : "Transcript unavailable or too short.",
          ...v,
        });
        continue;
      }

      const summary = await summarizeTranscript({
        title: v.title,
        channelName: v.channelName,
        transcriptText: t.text,
        maxBullets: 5,
      });

      summarizedItems.push({
        status: "summarized",
        summary,
        ...v,
      });
    }

    // Merge summarized + skipped, sort by recency, then cap
    const combined = [
        ...summarizedItems.map((x) => ({
          status: "summarized",
          videoId: x.videoId,
          title: x.title,
          channelName: x.channelName,
          url: x.url,
          publishedAt: x.publishedAt,
          summary: x.summary,
        })),
        ...skippedItems.map((x) => ({
          status: "skipped",
          videoId: x.videoId,
          title: x.title,
          channelName: x.channelName,
          url: x.url,
          publishedAt: x.publishedAt,
          reason: x.reason,
        })),
    ].sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

    const displayed = combined.slice(0, cap);

    sectionsOut.push({
        label: pack.label,
        totalNew: videos.length,
        summarizedCount: summarizedItems.length,
        skippedCount: skippedItems.length,
        notShownCount: Math.max(0, combined.length - displayed.length),
        items: displayed,
    });
  }

  const { subject, text, html } = buildEmail({
    frequency: FREQUENCY,
    timezone: TIMEZONE,
    sections: sectionsOut,
  });

  // Print the text version to console (handy for debugging)
  console.log(subject);
  console.log(text);

  await sendEmail({ subject, text, html });

  console.log("Email sent.");
}

run().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
