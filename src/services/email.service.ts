import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const transporter = nodemailer.createTransport({
  host: env.EMAIL_SERVER_HOST,
  port: env.EMAIL_SERVER_PORT,
  secure: env.EMAIL_SERVER_SECURE,
  // Postmark SMTP auth: the server API token goes in as both user and pass.
  auth: { user: env.EMAIL_SERVER_USER, pass: env.EMAIL_SERVER_PASSWORD },
});

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  try {
    await transporter.sendMail({
      from: env.EMAIL_FROM,
      to,
      subject: 'Reset your password',
      text: `Reset your password using this link: ${resetUrl}\n\nThis link expires in ${env.PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.`,
      html: `<p>Reset your password using the link below.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in ${env.PASSWORD_RESET_TOKEN_TTL_MINUTES} minutes. If you did not request this, you can ignore this email.</p>`,
    });
  } catch (err) {
    logger.error({ err, to }, 'Failed to send password reset email');
    throw err;
  }
}
