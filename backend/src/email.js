import nodemailer from "nodemailer";
import { config } from "./config.js";

let transporter;

function isEmailConfigured() {
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

function compactLines(lines) {
  return lines.filter(line => line !== null && line !== undefined && line !== "").join("\n");
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
    from: senderAddress(),
    to,
    subject,
    text
  });

  return { sent: true };
}
