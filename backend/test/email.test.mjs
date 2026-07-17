import assert from "node:assert/strict";
import test from "node:test";
import { buildNewsletterSubscriberReviewMessage } from "../src/email.js";

test("approved newsletter review message includes branded HTML and a text fallback", () => {
  const message = buildNewsletterSubscriberReviewMessage({
    displayName: "Taylor & Family",
    decision: "approved",
    publicUrl: "https://876en.org/"
  });

  assert.equal(message.subject, "You’re on the Black Shadow newsletter list");
  assert.match(message.text, /Taylor & Family,/);
  assert.match(message.text, /https:\/\/876en\.org\//);
  assert.match(message.html, /Black Shadow Company/);
  assert.match(message.html, /Taylor &amp; Family/);
  assert.match(message.html, /Visit the 876 EN site/);
});

test("newsletter review message escapes subscriber content and ignores unsafe links", () => {
  const message = buildNewsletterSubscriberReviewMessage({
    displayName: "<script>alert('x')</script>",
    decision: "rejected",
    publicUrl: "javascript:alert('x')"
  });

  assert.equal(message.subject, "Update on your newsletter request");
  assert.doesNotMatch(message.html, /<script>/);
  assert.doesNotMatch(message.html, /javascript:/);
  assert.doesNotMatch(message.html, /Visit the 876 EN site/);
  assert.match(message.text, /was not approved at this time/);
});
