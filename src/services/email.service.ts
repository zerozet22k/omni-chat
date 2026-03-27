import nodemailer from "nodemailer";
import { env } from "../config/env";

class EmailService {
  private getTransport() {
    if (
      !env.SMTP_HOST.trim() ||
      !env.SMTP_USER.trim() ||
      !env.SMTP_PASS.trim() ||
      !env.SMTP_FROM_EMAIL.trim()
    ) {
      return null;
    }

    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }

  isConfigured() {
    return !!this.getTransport();
  }

  async sendWorkspaceInvitation(params: {
    toEmail: string;
    toName?: string | null;
    workspaceName: string;
    inviterName?: string | null;
    inviteUrl: string;
    workspaceRoleLabel: string;
  }) {
    const transport = this.getTransport();
    if (!transport) {
      return {
        sent: false,
        skipped: true,
        reason: "SMTP is not configured",
      };
    }

    const fromName = env.SMTP_FROM_NAME.trim() || params.workspaceName;
    const greetingName = params.toName?.trim() || params.toEmail;
    const inviter = params.inviterName?.trim() || params.workspaceName;

    await transport.sendMail({
      from: `"${fromName}" <${env.SMTP_FROM_EMAIL}>`,
      to: params.toEmail,
      subject: `Invitation to join ${params.workspaceName}`,
      text: [
        `Hello ${greetingName},`,
        "",
        `${inviter} invited you to join ${params.workspaceName} as ${params.workspaceRoleLabel}.`,
        "",
        "Use this link to accept the invitation and set your password:",
        params.inviteUrl,
        "",
        "If you were not expecting this invitation, you can ignore this email.",
      ].join("\n"),
      html: `
        <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #0f172a;">
          <p>Hello ${greetingName},</p>
          <p>${inviter} invited you to join <strong>${params.workspaceName}</strong> as <strong>${params.workspaceRoleLabel}</strong>.</p>
          <p>
            <a href="${params.inviteUrl}" style="display: inline-block; background: #0f172a; color: #ffffff; text-decoration: none; padding: 10px 16px; border-radius: 10px;">
              Accept invitation
            </a>
          </p>
          <p style="word-break: break-all;">${params.inviteUrl}</p>
          <p>If you were not expecting this invitation, you can ignore this email.</p>
        </div>
      `,
    });

    return {
      sent: true,
      skipped: false,
    };
  }
}

export const emailService = new EmailService();
