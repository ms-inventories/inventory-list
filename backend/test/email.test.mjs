import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewsletterIssueMessage,
  buildNewsletterSubscriberReviewMessage,
  proofSenderAddress
} from "../src/email.js";
import { config } from "../src/config.js";

test("proof alerts use the dedicated 876 EN proof sender", () => {
  assert.equal(proofSenderAddress(), `${config.email.proofFromName} <${config.email.proofFromAddress}>`);
  assert.equal(config.email.proofFromAddress, process.env.PROOF_EMAIL_FROM_ADDRESS || "proof@876en.org");
});

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

test("newsletter issue message includes branded HTML and a text fallback", () => {
  const message = buildNewsletterIssueMessage({
    issue: {
      title: "July family update",
      editionLabel: "Test edition",
      summary: "A short summary for the inbox preview.",
      body: "First paragraph.\n\nSecond paragraph."
    },
    publicUrl: "https://876en.org/",
    unsubscribeUrl: "https://876en.org/#/unsubscribe?email=test%40example.com"
  });

  assert.equal(message.subject, "Test edition: July family update");
  assert.match(message.text, /First paragraph/);
  assert.match(message.text, /Unsubscribe:/);
  assert.match(message.html, /Black Shadow Company/);
  assert.match(message.html, /A short summary for the inbox preview/);
  assert.match(message.html, /Visit the 876 EN site/);
  assert.match(message.html, />Unsubscribe</);
});

test("newsletter issue message keeps the edition label from a published database row", () => {
  const message = buildNewsletterIssueMessage({
    issue: {
      title: "July family update",
      edition_label: "Published edition",
      summary: "A published issue summary.",
      body: "Published issue body."
    },
    publicUrl: "https://876en.org/",
    unsubscribeUrl: "https://876en.org/#/unsubscribe?email=test%40example.com"
  });

  assert.equal(message.subject, "Published edition: July family update");
  assert.match(message.text, /^Published edition/m);
  assert.match(message.html, />Published edition</);
});

test("newsletter issue message escapes content and ignores unsafe links", () => {
  const message = buildNewsletterIssueMessage({
    issue: {
      title: "<script>alert('title')</script>",
      editionLabel: "<b>Edition</b>",
      summary: "<img src=x onerror=alert(1)>",
      body: "Hello <script>alert('body')</script>"
    },
    publicUrl: "javascript:alert('x')",
    unsubscribeUrl: "data:text/html,bad"
  });

  assert.doesNotMatch(message.html, /<script>/);
  assert.doesNotMatch(message.html, /<img/);
  assert.doesNotMatch(message.html, /javascript:/);
  assert.doesNotMatch(message.html, />Unsubscribe</);
  assert.doesNotMatch(message.html, /Visit the 876 EN site/);
});
