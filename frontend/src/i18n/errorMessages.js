// Backend errors now carry a stable machine-readable `code` (see each
// service's `XError` class and services/api.js, which copies it onto the
// thrown Error) - translated here by code, which can't be broken by a
// backend wording change the way matching the literal English message
// could. `meta` (e.g. { n: 140 }) carries the runtime value for messages
// like "Title must be 140 characters or fewer.".
//
// The STATIC/PATTERNS dictionary below still exists as a fallback for the
// rare error that doesn't carry a code (a genuinely unexpected failure,
// or a call site that predates this) - matching by message text is worse
// than matching by code, but still better than showing nothing.
const STATIC = {
  "Invalid email or password.": "errors.invalidCredentials",
  "Invalid session.": "errors.invalidSession",
  "Session ended. Please sign in again.": "errors.sessionEnded",
  "Session expired. Please sign in again.": "errors.sessionExpired",
  "Moderator access required.": "errors.moderatorRequired",
  "Not your listing.": "errors.notYourListing",
  "Not your order.": "errors.notYourOrder",
  "Only the buyer can do that.": "errors.onlyBuyer",
  "Only the seller can do that.": "errors.onlySeller",
  "This listing was removed by a moderator and can't be changed.": "errors.listingRemoved",
  "Verify your email first.": "errors.verifyEmailFirst",
  "You can no longer message in this conversation.": "errors.cantMessageConversation",
  "You can only review someone once the order is complete - the buyer needs to confirm they received the item first.": "errors.reviewNeedsCompletion",
  "You can't message this seller.": "errors.cantMessageSeller",
  "You're not part of this conversation.": "errors.notInConversation",
  "Conversation not found.": "errors.conversationNotFound",
  "Issue not found, or already resolved.": "errors.issueNotFound",
  "Listing not found.": "errors.listingNotFound",
  "No account with that email.": "errors.noAccountWithEmail",
  "Notification not found.": "errors.notificationNotFound",
  "Order not found.": "errors.orderNotFound",
  "Report not found.": "errors.reportNotFound",
  "The thing you're reporting doesn't exist.": "errors.reportTargetMissing",
  "Upload not found.": "errors.uploadNotFound",
  "User not found.": "errors.userNotFound",
  "An account with that email already exists.": "errors.emailInUse",
  "That order isn't disputed.": "errors.orderNotDisputed",
  "The order changed while we were updating it.": "errors.orderChanged",
  "This listing has a payment in progress - wait for it to complete or expire before changing its status.": "errors.listingPaymentInProgress",
  "This listing has buyer messages - mark it sold instead of deleting, so buyers keep their conversation history.": "errors.listingHasMessages",
  "This listing is already taken down.": "errors.listingAlreadyTakenDown",
  "This listing is no longer available - someone else may have just bought it.": "errors.listingGone",
  "This listing is no longer available.": "errors.listingUnavailable",
  "This seller hasn't finished setting up payouts yet, so this item can't be bought right now.": "errors.sellerPayoutsNotReady",
  "You've already reported this - it's in the queue.": "errors.alreadyReported",
  "You've already reviewed this person for this listing.": "errors.alreadyReviewed",
  "This upload expired - request a new upload URL.": "errors.uploadExpired",
  "Too many attempts — request a new code.": "errors.tooManyCodeAttempts",
  "Couldn't complete checkout - please try again.": "errors.checkoutFailed",
  "Stripe couldn't create the payment - check your Stripe test keys.": "errors.stripeCreateFailed",
  "Stripe isn't configured, so a refund can't be issued.": "errors.stripeNotConfiguredRefund",
  "A reason is required to raise a dispute.": "errors.disputeReasonRequired",
  "A resolution note is required.": "errors.resolutionNoteRequired",
  "Already verified — log in instead.": "errors.alreadyVerified",
  "Image is still too large after resizing.": "errors.imageStillTooLarge",
  "Invalid upload key.": "errors.invalidUploadKey",
  "Missing required listing fields.": "errors.missingListingFields",
  "Name, email and a password (6+ characters) are required.": "errors.signupFieldsRequired",
  "No fields to update.": "errors.noFieldsToUpdate",
  "Only images can be uploaded.": "errors.onlyImages",
  "Password must be at least 8 characters.": "errors.passwordTooShort",
  "Price must be a positive amount.": "errors.priceMustBePositive",
  "Title is required.": "errors.titleRequired",
  "That code doesn't match.": "errors.codeMismatch",
  "That code has expired — request a new one.": "errors.codeExpired",
  "That doesn't look like a valid image.": "errors.notAnImage",
  "That reset link is invalid or has expired.": "errors.resetLinkInvalid",
  "You can't block yourself.": "errors.cantBlockYourself",
  "You can't buy your own listing.": "errors.cantBuyOwnListing",
  "You can't message your own listing.": "errors.cantMessageOwnListing",
  "You can't report yourself.": "errors.cantReportYourself",
  "You can't review yourself.": "errors.cantReviewYourself",
};

// Only still needed for the fallback path above - a coded error carries
// its dynamic value in `meta` instead (see backend error classes' 4th
// constructor argument) rather than needing it regex-extracted back out
// of the rendered English sentence.
const PATTERNS = [
  { re: /^Title must be (\d+) characters or fewer\.$/, key: "errors.titleTooLong", group: "n" },
  { re: /^Description must be (\d+) characters or fewer\.$/, key: "errors.descriptionTooLong", group: "n" },
  { re: /^Size\/age must be (\d+) characters or fewer\.$/, key: "errors.sizeOrAgeTooLong", group: "n" },
  { re: /^Detail must be (\d+) characters or fewer\.$/, key: "errors.detailTooLong", group: "n" },
  { re: /^Messages must be (\d+) characters or fewer\.$/, key: "errors.messageTooLong", group: "n" },
  { re: /^Price must be ([\d.]+) EUR or less\.$/, key: "errors.priceTooHigh", group: "amount" },
  { re: /^Too many failed attempts\. Try again in (\d+) minute\(s\)\.$/, key: "errors.tooManyFailedAttempts", group: "n" },
];

// `error` is normally the Error thrown by services/api.js's apiFetch (has
// `.message`, and `.code`/`.meta` when the backend sent them). A bare
// string is also accepted so call sites aren't forced to change together -
// it just can't benefit from code-based translation, only the fallback.
export function translateServerError(error, t) {
  if (!error) return error;
  const isString = typeof error === "string";
  const message = isString ? error : error.message;
  const code = isString ? null : error.code;

  if (code) return t(`errors.${code}`, isString ? undefined : error.meta || undefined);

  if (!message) return message;
  const staticKey = STATIC[message];
  if (staticKey) return t(staticKey);
  for (const { re, key, group } of PATTERNS) {
    const match = message.match(re);
    if (match) return t(key, { [group]: match[1] });
  }
  return message;
}
