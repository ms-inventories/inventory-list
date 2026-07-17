import nodemailer from "nodemailer";
import { config } from "./config.js";

let transporter;

export function isEmailConfigured() {
  return Boolean(config.email.host && config.email.user && config.email.pass && config.email.fromAddress);
}

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: {
        user: config.email.user,
        pass: config.email.pass
      }
    });
  }

  return transporter;
}

export async function sendTenantInviteEmail({ to, tenantName, role, inviteUrl, invitedByName }) {
  if (!isEmailConfigured()) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const sender = `${config.email.fromName} <${config.email.fromAddress}>`;
  const subject = `Inventory invite: ${tenantName}`;
  const inviter = invitedByName ? `${invitedByName} invited you` : "You were invited";
  const text = [
    `${inviter} to ${tenantName} as ${role}.`,
    "",
    "Open this link to accept the invite:",
    inviteUrl,
    "",
    "If you were not expecting this, ignore this email."
  ].join("\n");

  await getTransporter().sendMail({
    from: sender,
    to,
    subject,
    text
  });

  return { sent: true };
}

function senderAddress() {
  return `${config.email.fromName} <${config.email.fromAddress}>`;
}

function newsletterSenderAddress() {
  const name = config.email.newsletterFromName || config.email.fromName;
  const address = config.email.newsletterFromAddress || config.email.fromAddress;
  return `${name} <${address}>`;
}

function compactLines(lines) {
  return lines.filter(line => line !== null && line !== undefined && line !== "").join("\n");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safePublicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

export function buildNewsletterSubscriberReviewMessage({ displayName, decision, publicUrl }) {
  const approved = decision === "approved";
  const subject = approved
    ? "You’re on the Black Shadow newsletter list"
    : "Update on your newsletter request";
  const greeting = displayName ? `${displayName},` : "Hello,";
  const headline = approved ? "You’re on the list" : "Request update";
  const statusLabel = approved ? "Approved" : "Not approved";
  const message = approved
    ? "Your request for Black Shadow Company newsletter updates has been approved. Future family updates, event reminders, and resources will be sent to this address."
    : "Your request for Black Shadow Company newsletter updates was reviewed and was not approved at this time.";
  const normalizedPublicUrl = safePublicUrl(publicUrl);
  const text = compactLines([
    greeting,
    "",
    message,
    "",
    normalizedPublicUrl ? `Visit the 876 EN site: ${normalizedPublicUrl}` : null,
    "",
    "If you have questions, contact the company FRG team."
  ]);
  const preheader = approved
    ? "Your newsletter request has been approved."
    : "Your newsletter request has been reviewed.";
  const accent = approved ? "#4f6b25" : "#80601c";
  const escapedUrl = escapeHtml(normalizedPublicUrl);
  const button = normalizedPublicUrl
    ? `
                <tr>
                  <td style="padding:8px 36px 32px;">
                    <a href="${escapedUrl}" style="background:#d9b96e;border-radius:6px;color:#172015;display:inline-block;font-family:Arial,sans-serif;font-size:15px;font-weight:700;line-height:20px;padding:13px 20px;text-decoration:none;">Visit the 876 EN site</a>
                  </td>
                </tr>`
    : "";
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="background:#ece9df;margin:0;padding:0;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#ece9df;width:100%;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#ffffff;border:1px solid #d8d4c8;border-radius:10px;box-shadow:0 4px 18px rgba(23,32,21,.08);max-width:600px;overflow:hidden;width:100%;">
            <tr>
              <td style="background:#263322;border-bottom:4px solid #d9b96e;padding:28px 36px;">
                <div style="color:#d9b96e;font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">876 EN</div>
                <div style="color:#ffffff;font-family:Georgia,serif;font-size:24px;font-weight:700;line-height:30px;margin-top:5px;">Black Shadow Company</div>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 36px 12px;">
                <div style="color:${accent};font-family:Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;">${statusLabel}</div>
                <h1 style="color:#1f291d;font-family:Georgia,serif;font-size:30px;line-height:36px;margin:8px 0 20px;">${escapeHtml(headline)}</h1>
                <p style="color:#3f473d;font-family:Arial,sans-serif;font-size:16px;line-height:25px;margin:0 0 16px;">${escapeHtml(greeting)}</p>
                <p style="color:#3f473d;font-family:Arial,sans-serif;font-size:16px;line-height:25px;margin:0;">${escapeHtml(message)}</p>
              </td>
            </tr>${button}
            <tr>
              <td style="background:#f6f4ed;border-top:1px solid #e2ded2;padding:22px 36px;">
                <p style="color:#697066;font-family:Arial,sans-serif;font-size:13px;line-height:20px;margin:0;">Questions? Contact the company FRG team.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  return { subject, text, html };
}

export async function sendProofSubmittedEmail({
  to,
  tenantName,
  sessionName,
  packetLine,
  submittedByName,
  status,
  locationText,
  serialNumber,
  note,
  photoCount,
  reviewUrl
}) {
  if (!isEmailConfigured()) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const subject = `Proof submitted: ${tenantName}`;
  const text = compactLines([
    `${submittedByName || "A helper"} submitted inventory proof for ${tenantName}.`,
    "",
    `Session: ${sessionName || "Inventory session"}`,
    packetLine ? `Packet row: ${packetLine}` : null,
    `Status: ${status}`,
    locationText ? `Location: ${locationText}` : null,
    serialNumber ? `Serial: ${serialNumber}` : null,
    typeof photoCount === "number" ? `Photos: ${photoCount}` : null,
    note ? `Note: ${note}` : null,
    "",
    "Review it here:",
    reviewUrl
  ]);

  await getTransporter().sendMail({
    from: senderAddress(),
    to,
    subject,
    text
  });

  return { sent: true };
}

export async function sendProofRequestEmail({
  to,
  tenantName,
  sessionName,
  packetLine,
  requestedByName,
  decisionNote,
  taskUrl
}) {
  if (!isEmailConfigured()) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const subject = `More proof needed: ${tenantName}`;
  const text = compactLines([
    `${requestedByName || "The platoon admin"} requested more inventory proof for ${tenantName}.`,
    "",
    `Session: ${sessionName || "Inventory session"}`,
    packetLine ? `Packet row: ${packetLine}` : null,
    decisionNote ? `Request: ${decisionNote}` : "Request: Send another photo or more detail when you can.",
    "",
    "Open your task list here:",
    taskUrl
  ]);

  await getTransporter().sendMail({
    from: senderAddress(),
    to,
    subject,
    text
  });

  return { sent: true };
}

export async function sendNewsletterIssueEmail({ to, issue, unsubscribeUrl }) {
  if (!isEmailConfigured()) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const subject = issue.editionLabel
    ? `${issue.editionLabel}: ${issue.title}`
    : issue.title;
  const text = compactLines([
    issue.summary || null,
    "",
    issue.body,
    "",
    unsubscribeUrl ? `Unsubscribe: ${unsubscribeUrl}` : null
  ]);

  await getTransporter().sendMail({
    from: newsletterSenderAddress(),
    to,
    subject,
    text
  });

  return { sent: true };
}

export async function sendNewsletterSubscriberReviewEmail({ to, displayName, decision, publicUrl }) {
  if (!isEmailConfigured()) {
    return { sent: false, reason: "smtp_not_configured" };
  }

  const { subject, text, html } = buildNewsletterSubscriberReviewMessage({ displayName, decision, publicUrl });

  await getTransporter().sendMail({
    from: newsletterSenderAddress(),
    to,
    subject,
    text,
    html
  });

  return { sent: true };
}
