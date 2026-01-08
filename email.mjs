import nodemailer from "nodemailer";

/**
 * buildEmail({ frequency, timezone, sections }) -> { subject, text, html }
 *
 * 1-column layout (mobile-safe) with thumbnail on top.
 * Keeps bullets (key points).
 * Removes "Who should watch".
 */
export function buildEmail({ frequency, timezone, sections }) {
  const nowStr = new Date().toLocaleString("en-US", { timeZone: timezone });

  const totalShown = (sections || []).reduce(
    (acc, s) => acc + (s.items?.length || 0),
    0
  );

  const subjectPrefix =
    frequency === "weekly" ? "Weekly YouTube Digest" : "Your YouTube Digest";
  const subject = `${subjectPrefix} — ${totalShown} videos`;

  function formatReason(raw) {
    const s = String(raw || "").trim();

    // Empty / missing
    if (!s) return "No transcript/captions available.";

    const lower = s.toLowerCase();

    // Common known cases
    if (lower.includes("no_transcript") || lower.includes("no transcript"))
      return "No transcript/captions available on YouTube.";
    if (lower.includes("too_short"))
      return "Transcript exists but is too short to summarize reliably.";

    // Vendor / network / rate limiting vibes
    if (lower.includes("scrapingdog") && lower.includes("502"))
      return "Transcript provider temporarily unavailable (502).";
    if (lower.includes("502") || lower.includes("bad gateway"))
      return "Temporary upstream error (502).";
    if (lower.includes("429") || lower.includes("rate"))
      return "Rate-limited temporarily. Will retry next run.";
    if (lower.includes("timeout") || lower.includes("timed out"))
      return "Request timed out while fetching transcript.";
    if (lower.includes("fetch failed") || lower.includes("network"))
      return "Network error while fetching transcript.";

    // If someone accidentally passed the whole HTML page / huge blob
    if (lower.includes("<!doctype html") || lower.includes("<html"))
      return "Transcript provider returned an unexpected response.";

    // Default: keep it short, one line max
    return s.length > 140 ? s.slice(0, 137) + "..." : s;
  }

  // ---------- TEXT VERSION ----------
  let text = "";
  text += `YouTube Digest\n`;
  text += `Period: ${frequency}\n`;
  text += `Generated: ${nowStr} (${timezone})\n\n`;

  for (const section of sections || []) {
    const label = section.label || section.title || "SECTION";
    const totalNew = section.totalNew ?? section.newCount ?? section.stats?.newCount;
    const summarizedCount = section.summarizedCount ?? section.stats?.summarized;
    const skippedCount = section.skippedCount ?? section.stats?.skipped;
    const notShownCount =
      section.notShownCount ?? section.stats?.notShownCount ?? section.stats?.notShown;

    text += `${String(label).toUpperCase()}\n`;
    if (
      typeof totalNew === "number" ||
      typeof summarizedCount === "number" ||
      typeof skippedCount === "number" ||
      typeof notShownCount === "number"
    ) {
      text += `(${totalNew ?? 0} new • ${summarizedCount ?? 0} summarized • ${
        skippedCount ?? 0
      } skipped • ${notShownCount ?? 0} not shown)\n\n`;
    } else {
      text += `\n`;
    }

    for (const item of section.items || []) {
      const status = item.status || (item.summary ? "summarized" : "skipped");

      text +=
        status === "summarized"
          ? `📌 ${item.title}\n`
          : `⚠️ ${item.title} (Not summarized)\n`;

      text += `Channel: ${item.channelName || item.channel || ""}\n`;
      text += `Watch: ${item.url}\n`;
      text += `Published: ${item.publishedAt || item.published || ""}\n`;

      if (status === "summarized") {
        const one = item.summary?.one_liner || "";
        text += `\nSummary: ${one}\n`;

        const pts = Array.isArray(item.summary?.key_points)
          ? item.summary.key_points
          : [];
        if (pts.length) {
          text += `Key points:\n`;
          for (const p of pts) text += `• ${p}\n`;
        }
        if (item.source) text += `Source: ${item.source}\n`;
      } else {
        const niceReason = formatReason(item.reason);
        text += `No summary available.\nReason: ${niceReason}\n`;
      }

      text += `\n━━━━━━━━━━━━━━━━━━━━━━\n\n`;
    }
    text += `\n`;
  }

  text += `Neutral summaries generated from publicly available transcripts.\n`;

  // ---------- HTML VERSION ----------
  const css = `
    body { margin:0; padding:0; background:#F6F7FB; }
    a { color:#0B57D0; text-decoration:none; }
    a:hover { text-decoration:underline; }
  `;

  const htmlSections = (sections || [])
    .map((section) => {
      const label = section.label || section.title || "SECTION";
      const totalNew = section.totalNew ?? section.newCount ?? section.stats?.newCount;
      const summarizedCount = section.summarizedCount ?? section.stats?.summarized;
      const skippedCount = section.skippedCount ?? section.stats?.skipped;
      const notShownCount =
        section.notShownCount ?? section.stats?.notShownCount ?? section.stats?.notShown;

      const statsLine =
        typeof totalNew === "number" ||
        typeof summarizedCount === "number" ||
        typeof skippedCount === "number" ||
        typeof notShownCount === "number"
          ? `${totalNew ?? 0} new • ${summarizedCount ?? 0} summarized • ${
              skippedCount ?? 0
            } skipped • ${notShownCount ?? 0} not shown`
          : "";

      const itemsHtml = (section.items || []).map((item) => renderCard(item, { formatReason })).join("");

      return `
        <tr>
          <td style="padding:18px 18px 8px 18px;">
            <div style="font-family:Arial, sans-serif; font-size:14px; font-weight:800; letter-spacing:0.08em; color:#111;">
              ${escapeHtml(String(label).toUpperCase())}
            </div>
            ${
              statsLine
                ? `<div style="margin-top:6px;font-family:Arial, sans-serif; font-size:13px; color:#666;">${escapeHtml(
                    statsLine
                  )}</div>`
                : ""
            }
          </td>
        </tr>
        ${itemsHtml}
      `;
    })
    .join("");

  const html = `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <style>${css}</style>
    <title>YouTube Digest</title>
  </head>
  <body>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;background:#F6F7FB;">
      <tr>
        <td align="center" style="padding:0 10px;">
          <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="border-collapse:collapse;max-width:640px;width:100%;background:#FFFFFF;">
            <tr>
              <td style="padding:22px 18px 10px 18px;">
                <div style="font-family:Arial, sans-serif;font-size:22px;font-weight:900;color:#111;line-height:1.2;">YouTube Digest</div>
                <div style="margin-top:10px;font-family:Arial, sans-serif;color:#666;font-size:13px;line-height:1.5;">
                  <div><span style="font-weight:700;color:#111;">Period:</span> ${escapeHtml(frequency)}</div>
                  <div><span style="font-weight:700;color:#111;">Generated:</span> ${escapeHtml(nowStr)} (${escapeHtml(
                    timezone
                  )})</div>
                </div>
              </td>
            </tr>

            ${htmlSections}

            <tr>
              <td style="padding:18px 18px 26px 18px;font-family:Arial, sans-serif;color:#777;font-size:12px;line-height:1.5;">
                Neutral summaries generated from publicly available transcripts.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();

  return { subject, text, html };
}

export async function sendEmail({ subject, text, html }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to: process.env.EMAIL_TO,
    subject,
    text,
    html,
  });
}

/* -------------------- helpers -------------------- */

function renderCard(item, opts = {}) {
  const { formatReason } = opts;

  const status = item.status || (item.summary ? "summarized" : "skipped");

  const title = escapeHtml(item.title || "");
  const url = safeUrl(item.url);
  const channel = escapeHtml(item.channelName || item.channel || "");
  const published = escapeHtml(item.publishedAt || item.published || "");
  const thumbUrl = youtubeThumb(item);

  const badge =
    status === "summarized"
      ? `<span style="display:inline-block;font-size:12px;line-height:1;padding:6px 10px;border-radius:999px;background:#E7F7EF;color:#0B6B3A;font-weight:700;">Summarized</span>`
      : `<span style="display:inline-block;font-size:12px;line-height:1;padding:6px 10px;border-radius:999px;background:#FFF3E6;color:#8A4B00;font-weight:700;">Not summarized</span>`;

  const oneLiner =
    status === "summarized"
      ? escapeHtml(item.summary?.one_liner || "")
      : `No summary available.`;

  const keyPoints =
    status === "summarized" && Array.isArray(item.summary?.key_points)
      ? item.summary.key_points.filter(Boolean).slice(0, 6)
      : [];

  const keyPointsHtml =
    keyPoints.length
      ? `
        <div style="margin-top:10px;font-weight:800;color:#111;">Key points:</div>
        <ul style="margin:8px 0 0 18px;padding:0;color:#222;line-height:1.45;">
          ${keyPoints.map((p) => `<li style="margin:0 0 6px 0;">${escapeHtml(p)}</li>`).join("")}
        </ul>
      `
      : "";

  const niceReason =
    typeof formatReason === "function"
      ? formatReason(item.reason)
      : (item.reason || "This video has no transcript/captions available on YouTube.");

  const reasonHtml =
    status !== "summarized"
      ? `
        <div style="margin-top:10px;color:#444;font-size:13px;line-height:1.45;">
          <span style="font-weight:800;">Reason:</span> ${escapeHtml(niceReason)}
        </div>
      `
      : "";

  return `
    <tr>
      <td style="padding:10px 18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0;background:#FFFFFF;border:1px solid #E9E9E9;border-radius:14px;overflow:hidden;">
          <tr>
            <td style="padding:0;">
              <a href="${url}" style="text-decoration:none;">
                <img src="${thumbUrl}" alt="" style="width:100%;max-width:640px;height:auto;display:block;border:0;outline:none;text-decoration:none;background:#F6F7FB;">
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 14px 12px 14px;font-family:Arial, sans-serif;">
              <div style="margin-bottom:10px;">${badge}</div>

              <div style="font-size:18px;line-height:1.25;font-weight:900;margin:0 0 6px 0;">
                <a href="${url}" style="color:#111;text-decoration:none;">${title}</a>
              </div>

              <div style="color:#666;font-size:13px;line-height:1.35;margin:0 0 10px 0;">
                ${channel}${channel && published ? " • " : ""}${published}
              </div>

              <div style="color:#111;font-size:14px;line-height:1.5;">
                <span style="font-weight:900;">Summary:</span> ${oneLiner}
              </div>

              ${reasonHtml}
              ${keyPointsHtml}

              <div style="margin-top:12px;">
                <a href="${url}" style="display:inline-block;color:#0B57D0;text-decoration:none;font-weight:900;">
                  Watch →
                </a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `;
}


function youtubeThumb(item) {
  // Prefer explicit thumbnail if you already store it
  if (item.thumbnail && (String(item.thumbnail).startsWith("http://") || String(item.thumbnail).startsWith("https://"))) {
    return String(item.thumbnail);
  }

  // Otherwise derive from videoId or URL
  const vid = item.videoId || extractVideoId(item.url);
  if (!vid) return "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg";

  return `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`;
}

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.replace("/", "") || null;
    }
    if (u.searchParams.has("v")) return u.searchParams.get("v");
    return null;
  } catch {
    return null;
  }
}

function safeUrl(u) {
  const s = String(u || "").trim();
  return s.startsWith("http://") || s.startsWith("https://") ? s : "#";
}

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
