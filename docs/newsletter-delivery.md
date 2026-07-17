# Newsletter Delivery

Use this checklist before turning on live newsletter delivery.

## Production Environment

Set these on the backend service only:

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<brevo-smtp-login>
SMTP_PASS=<brevo-smtp-key>
EMAIL_FROM_NAME=876 EN Inventory
EMAIL_FROM_ADDRESS=no-reply@876en.org
NEWSLETTER_FROM_NAME=Black Shadow Company
NEWSLETTER_FROM_ADDRESS=newsletter@876en.org
PUBLIC_APP_URL=https://876en.org
```

`NEWSLETTER_FROM_*` uses the same Brevo SMTP credentials while giving newsletter messages their own recognizable sender. Add and authenticate `876en.org` in the existing Brevo account; a separate Brevo account is not required. Make sure the selected address exists as a mailbox or forwards replies to the FRG team.

Do not commit real SMTP credentials. Rotate any key that is pasted into chat, logs, screenshots, or local notes.

## Brevo Checks

- Add `876en.org` as a sending domain in Brevo and publish its DKIM and DMARC DNS records.
- Add `newsletter@876en.org` as a sender after the domain is authenticated.
- Send a test issue from the newsletter admin screen before publishing to subscribers.
- Confirm Brevo accepts the message and that the sender, subject, and unsubscribe link look right.
- Publish only after the test message looks correct.

## App Behavior

- Test sends use `POST /api/newsletter/admin/issues/:issueId/test-send`.
- Test sends do not publish the issue and do not create delivery records.
- Published issues create `newsletter_deliveries` rows for approved subscribers.
- If SMTP is not configured, delivery records are saved as skipped so QA can still verify the flow.
- Subscriber and delivery CSV exports are available from the newsletter admin screen.
- Unsubscribe links point to `https://876en.org/#/unsubscribe?email=<email>`.

## Follow-Up Hardening

- Replace email-only unsubscribe links with signed unsubscribe tokens before opening the list broadly.
- Add bounced-email handling if Brevo webhooks are enabled later.
- Keep FRG/newsletter content public-safe because the homepage is visible without authentication.
