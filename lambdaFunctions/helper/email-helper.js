const nodemailer = require("nodemailer");

// Reuse the SMTP connection across invocations
const mailer = (() => {
  // Choose auth method based on available env vars
  if (process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN) {
    // OAuth2 auth (Workspace-friendly)
    return nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: {
        type: "OAuth2",
        user: process.env.GMAIL_USER,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      },
      // Optional timeouts for Lambda
      connectionTimeout: 10_000,
      socketTimeout: 10_000,
    });
  }

  // App Password auth (simple)
  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,            // or 587 + secure:false + requireTLS:true
    secure: true,
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD,
    },
    connectionTimeout: 10_000,
    socketTimeout: 10_000,
  });
})();

/**
 * Compose & send the invitation email
 */
async function sendInvitationEmail({ to, roleToAssign, siteName, siteId, invitationId }) {
  const fromName  = process.env.FROM_NAME || "Site Admin";
  const fromEmail = process.env.FROM_EMAIL || process.env.GMAIL_USER;
  const baseUrl   = process.env.INVITE_ACCEPT_BASE_URL || "https://app.example.com/accept-invite";

  // The link your app will handle to accept the invite
  const acceptUrl = `${baseUrl}?inviteId=${encodeURIComponent(invitationId)}&siteId=${encodeURIComponent(siteId)}`;

  const subject = `You're invited to join ${siteName || "a site"} as ${roleToAssign}`;
  const text = [
    `Hi,`,
    ``,
    `You've been invited to join ${siteName || "a site"} as ${roleToAssign}.`,
    `Click the link below to accept your invitation:`,
    acceptUrl,
    ``,
    `If you didn't expect this email, you can ignore it.`,
  ].join("\n");

  const html = `
    <div style="font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111;">
      <h2 style="margin:0 0 12px">You're invited${siteName ? ` to <em>${escapeHtml(siteName)}</em>` : ""} 👋</h2>
      <p>You’ve been invited to join ${siteName ? `<strong>${escapeHtml(siteName)}</strong>` : "a site"} with the role <strong>${escapeHtml(roleToAssign)}</strong>.</p>
      <p>
        <a href="${acceptUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">
          Accept Invitation
        </a>
      </p>
      <p style="color:#555">Or paste this URL into your browser:<br><code>${acceptUrl}</code></p>
      <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
      <p style="color:#888;font-size:12px">Invite ID: ${invitationId}</p>
    </div>
  `;

  const info = await mailer.sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject,
    text,
    html,
  });

  return { messageId: info.messageId };
}

function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}
