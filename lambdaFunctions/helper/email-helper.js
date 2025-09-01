const nodemailer = require("nodemailer");


// OPTIONAL AWS lookups (works if runtime has aws-sdk v2; otherwise we silently skip)
let AWS = null;
try { AWS = require("aws-sdk"); } catch (_) {}

const USERS_TABLE = process.env.USERS_TABLE || process.env.AUTH_TABLE || process.env.USERS || null;
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || null;

function toTitleCase(s="") {
  return s.replace(/\b\w/g, c => c.toUpperCase());
}
function humanizeLocalPart(email="") {
  const local = (email.split("@")[0] || "").replace(/[._-]+/g, " ");
  return toTitleCase(local || "there");
}

async function lookupInviteeNameFromDynamo(email) {
  if (!AWS || !USERS_TABLE) return null;
  const doc = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });
  // Try a targeted scan by common email attribute names
  const params = {
    TableName: USERS_TABLE,
    FilterExpression: "#e = :e OR #el = :el OR #emailLower = :el",
    ExpressionAttributeNames: {
      "#e": "email", "#el": "emailLower", "#emailLower": "email_lower"
    },
    ExpressionAttributeValues: { ":e": email, ":el": email.toLowerCase() },
    Limit: 5
  };
  const res = await doc.scan(params).promise();
  const u = (res.Items || [])[0];
  if (!u) return null;

  // Try several common name shapes
  const full =
    u.name || u.fullName || u.displayName ||
    [u.firstName, u.lastName].filter(Boolean).join(" ") ||
    [u.given_name, u.family_name].filter(Boolean).join(" ") ||
    u.first_name || u.given_name;
  return full ? String(full) : null;
}

async function lookupInviteeNameFromCognito(email) {
  if (!AWS || !USER_POOL_ID) return null;
  const cog = new AWS.CognitoIdentityServiceProvider();
  const res = await cog.listUsers({
    UserPoolId: USER_POOL_ID,
    Filter: `email = "${email}"`,
    Limit: 1
  }).promise();
  const user = (res.Users || [])[0];
  if (!user) return null;
  const attrs = {};
  (user.Attributes || []).forEach(a => attrs[a.Name] = a.Value);
  const full = attrs.name || [attrs.given_name, attrs.family_name].filter(Boolean).join(" ");
  return full || null;
}

async function resolveInviteeName(email) {
  // best-effort chain: Dynamo -> Cognito -> local-part
  try { const n = await lookupInviteeNameFromDynamo(email); if (n) return n; } catch (_) {}
  try { const n = await lookupInviteeNameFromCognito(email); if (n) return n; } catch (_) {}
  return humanizeLocalPart(email);
}


async function sendInvitationEmail({ to, siteId, siteName, roleToAssign, invitationId }) {
  const fromName  = process.env.FROM_NAME  || "Site Admin";
  const fromEmail = process.env.FROM_EMAIL || process.env.GMAIL_USER;

  // Derive names (no param changes)
  const inviteeName  = await resolveInviteeName(to);
  const inviterName  = fromName; // use configured sender name as inviter

  // Build accept URL
  let baseUrl = process.env.INVITE_ACCEPT_BASE_URL || "https://example.com/accept-invite";
  if (!/^https?:\/\//i.test(baseUrl)) baseUrl = `https://${baseUrl}`;
  const acceptUrl = `${baseUrl}?inviteId=${encodeURIComponent(invitationId)}&siteId=${encodeURIComponent(siteId)}`;

  // HTML + Text
  const html = renderInviteHtml({ siteName, inviterName, inviteeName, acceptUrl, invitationId });
  const text = [
    `Hi ${inviteeName},`,
    ``,
    `${inviterName} has invited you to join ${siteName || "a site"} on DiGidot Horizon.`,
    `Accept: ${acceptUrl}`,
    ``,
    `If you did not expect this invitation, you can safely ignore this email.`,
    ``,
    `We look forward to having you on board!`,
    `— The DiGidot Team`,
    ``,
    `Invite ID: ${invitationId}`
  ].join("\n");

  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: `You’ve been invited to join a DiGidot Horizon site`,   // <== new subject
    text,
    html,
  });

  return { messageId: info.messageId };
}



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
