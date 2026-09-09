// Auto-replies on a seller's behalf using only the listing's real details,
// until the seller answers personally. Runs server-side so the Anthropic API
// key never reaches the browser.

function formatEuro(cents) {
  return `\u20ac${(cents / 100).toFixed(2)}`;
}

const logger = require("../logger");

const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);

// Signals that the AI genuinely couldn't produce a reply (API error,
// timeout, empty response) as distinct from having produced one. The
// caller uses this to decide whether to release its AI claim so a later
// message can retry - see messagesService.triggerAiReplyInBackground.
class AiUnavailableError extends Error {}

async function getAutoReply(listing, buyerMessage) {
  const prompt = `You are a helpful assistant standing in for a seller on a secondhand kids' marketplace, answering a buyer's question until the seller can reply personally. Use only the facts given below - never invent details.
Listing: "${listing.title}"
Category: ${listing.category}
Size/age: ${listing.size_or_age}
Condition: ${listing.condition}
Price: ${formatEuro(listing.price_cents)}
Location: ${listing.area}, ${listing.city} (${listing.pincode})
Description: ${listing.description}

Buyer's message: "${buyerMessage}"

Reply in 1-3 short sentences, warm and plain. If the buyer asks something not covered above (exact meetup time, final price negotiation, holding the item, etc.), say the seller will confirm that personally. Do not claim to be the seller by name.`;

  // Without a timeout, a hung request here would never resolve or reject -
  // the buyer would get no reply at all (not even the fallback text) rather
  // than a slow one, since the caller (triggerAiReplyInBackground) is just
  // waiting on this promise. AbortController turns "hangs forever" into "a
  // clean failure after AI_TIMEOUT_MS," which the existing catch below
  // already turns into the same graceful fallback text as any other error.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    const data = await response.json();
    if (!response.ok) {
      // A bad model id, bad API key, or rate limit still returns a normal
      // (non-thrown) JSON response with an error body - so this has to be
      // checked explicitly rather than relying on fetch to throw.
      logger.error("anthropic_api_error", { status: response.status, body: data });
      throw new AiUnavailableError(`Anthropic API returned ${response.status}`);
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    if (!text) {
      logger.error("anthropic_empty_response", { body: data });
      throw new AiUnavailableError("Anthropic API returned no text content");
    }
    return text;
  } catch (e) {
    if (e instanceof AiUnavailableError) throw e;
    if (e.name === "AbortError") logger.error("anthropic_timeout", { timeoutMs: AI_TIMEOUT_MS });
    else logger.error("anthropic_request_failed", { err: e });
    // Rethrow as a typed error so the caller can tell a genuine failure
    // (worth releasing the AI claim for, so a later message can retry -
    // see messagesService) apart from a successfully generated reply.
    // Previously this returned fallback text, which made every failure
    // indistinguishable from success to the caller.
    throw new AiUnavailableError(e.name === "AbortError" ? "timed out" : e.message);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { getAutoReply, AiUnavailableError };
