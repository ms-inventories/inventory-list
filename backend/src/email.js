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
