const nodemailer = require("nodemailer");


// OPTIONAL AWS lookups (works if runtime has aws-sdk v2; otherwise we silently skip)
let AWS = null;
try { AWS = require("aws-sdk"); } catch (_) {}

const USERS_TABLE = process.env.USERS_TABLE || null;
const USER_POOL_ID = process.env.USER_POOL_ID|| null;

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


// ---------- INVITER NAME HELPERS (NEW) ----------

// Try to resolve by userId or email from your USERS_TABLE (scan with common keys)
async function lookupInviterNameFromDynamo({ userId, email }) {
  if (!AWS || !USERS_TABLE) return null;
  const doc = new AWS.DynamoDB.DocumentClient({ convertEmptyValues: true });

  // Build a dynamic filter matching common id/email fields
  const names = {
    "#uid": "userId", "#aid": "authId", "#id": "id",
    "#e": "email", "#el": "emailLower", "#email_lower": "email_lower"
  };
  const values = {};
  const filters = [];

  if (userId) {
    values[":uid"] = userId;
    filters.push("#uid = :uid OR #aid = :uid OR #id = :uid");
  }
  if (email) {
    values[":e"] = email;
    values[":el"] = String(email).toLowerCase();
    filters.push("#e = :e OR #el = :el OR #email_lower = :el");
  }

  if (!filters.length) return null;

  const res = await doc.scan({
    TableName: USERS_TABLE,
    FilterExpression: filters.join(" OR "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    Limit: 5
  }).promise();

  const u = (res.Items || [])[0];
  if (!u) return null;

  // Common name shapes
  const full =
    u.name || u.fullName || u.displayName ||
    [u.firstName, u.lastName].filter(Boolean).join(" ") ||
    [u.given_name, u.family_name].filter(Boolean).join(" ") ||
    u.first_name || u.given_name;

  return full ? String(full) : null;
}

// Try Cognito by sub/username or email
async function lookupInviterNameFromCognito({ sub, email }) {
  if (!AWS || !USER_POOL_ID) return null;
  const cog = new AWS.CognitoIdentityServiceProvider();

  // Prefer AdminGetUser when we have a sub/username
  if (sub) {
    try {
      const g = await cog.adminGetUser({ UserPoolId: USER_POOL_ID, Username: sub }).promise();
      const attrs = {};
      (g.UserAttributes || []).forEach(a => attrs[a.Name] = a.Value);
      const full = attrs.name || [attrs.given_name, attrs.family_name].filter(Boolean).join(" ");
      if (full) return full;
    } catch (_) {}
  }

  // Fallback: search by email
  if (email) {
    try {
      const res = await cog.listUsers({
        UserPoolId: USER_POOL_ID,
        Filter: `email = "${email}"`,
        Limit: 1
      }).promise();
      const user = (res.Users || [])[0];
      if (user) {
        const attrs = {};
        (user.Attributes || []).forEach(a => attrs[a.Name] = a.Value);
        const full = attrs.name || [attrs.given_name, attrs.family_name].filter(Boolean).join(" ");
        if (full) return full;
      }
    } catch (_) {}
  }

  return null;
}

// Best-effort resolver; accepts any combination you can provide
async function resolveInviterName({ inviterNameArg, inviterClaims, inviterUserId, inviterEmail, inviterSub }) {
  // 1) explicit name wins
  if (inviterNameArg && String(inviterNameArg).trim()) return String(inviterNameArg).trim();

  // 2) JWT claims
  if (inviterClaims && typeof inviterClaims === "object") {
    const viaClaims =
      inviterClaims.name ||
      [inviterClaims.given_name, inviterClaims.family_name].filter(Boolean).join(" ");
    if (viaClaims && String(viaClaims).trim()) return String(viaClaims).trim();
    if (!inviterEmail) inviterEmail = inviterClaims.email;   // reuse for later steps
    if (!inviterSub)   inviterSub   = inviterClaims.sub;
  }

  // 3) Dynamo by userId/email
  try {
    const n = await lookupInviterNameFromDynamo({ userId: inviterUserId, email: inviterEmail });
    if (n) return n;
  } catch (_) {}

  // 4) Cognito by sub/email
  try {
    const n = await lookupInviterNameFromCognito({ sub: inviterSub, email: inviterEmail });
    if (n) return n;
  } catch (_) {}

  // 5) last resort: return null (caller will fallback to FROM_NAME)
  return null;
}





let _transporter;



function escapeHtml(s = "") {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;" }[c]));
}



function renderInviteHtml({ siteName, inviterName, inviteeName, acceptUrl, invitationId }) {
  const safe = {
    siteName: siteName ? `<strong>${escapeHtml(siteName)}</strong>` : "a site",
    inviterName: escapeHtml(inviterName || "The DiGidot Team"),
    inviteeName: escapeHtml(inviteeName || "there"),
    acceptUrl,
    invitationId: escapeHtml(invitationId)
  };
  const bg = "https://staging.horizon.digidot.eu/assets/img/background.png";

  return `<!doctype html>
<html lang="en" style="margin:0;padding:0;">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Invitation</title>
  </head>
  <body style="margin:0;padding:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.55;color:#111827;">
    <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="width:100%;background-color:#f5f7fb;">
      <tr>
        <td align="center" background="${bg}"
            style="padding:24px 12px;background-image:url('${bg}');background-repeat:no-repeat;background-position:center top;background-size:cover;">
          <!--[if gte mso 9]>
          <v:rect xmlns:v="urn:schemas-microsoft-com:vml" fill="true" stroke="false" style="width:1000px;height:100%;">
            <v:fill type="frame" src="${bg}" color="#f5f7fb" />
            <v:textbox inset="0,0,0,0">
          <![endif]-->

          <table role="presentation" width="600" border="0" cellspacing="0" cellpadding="0"
                 style="max-width:600px;background:#ffffff;border-radius:12px;box-shadow:0 6px 24px rgba(31,41,55,.08);overflow:hidden;">
            <tr>
                 <td align="center"
                    style="background:#40b3ed;padding:20px 24px;color:#ffffff;font-size:26px;font-weight:700;
                           border-radius:12px 12px 0 0;
                           font-family: Arial, Helvetica, sans-serif; /* ADD: enforce Arial */">
                  You're Invited
                </td>
            </tr>
            <tr>
              <td style="padding:28px;">
                <p style="margin:0 0 14px;">Hi ${safe.inviteeName},</p>

                <p style="margin:0 0 18px;">
                  <strong>${safe.inviterName}</strong> has invited you to join ${safe.siteName} on <strong>DiGidot Horizon</strong>.
                </p>
                 <p style="margin:0 0 18px;">
                  Click the button below to accept the invitation and get started:
                </p>

                <table role="presentation" border="0" cellspacing="0" cellpadding="0" width="100%" style="margin:16px 0 6px;">
                  <tr>
                    <td align="center">
                     <a href="${safe.acceptUrl}"
                        style="display:inline-block;background-color:#e5f3fb ;color:#008fd4;text-decoration:none;
                               padding:16px 22px;border-radius:12px;font-weight:700;letter-spacing:.2px;font-size:18px;
                               font-family: Arial, Helvetica, sans-serif; ">
                       Accept
                     </a>
                    </td>
                  </tr>
                </table>

                <p style="margin:18px 0 0;color:#6b7280;font-size:14px;">
                  Or paste this URL into your browser:<br />
                  <code style="word-break:break-all;">${safe.acceptUrl}</code>
                </p>

                <p style="margin:18px 0 0;">If you did not expect this invitation, you can safely ignore this email.</p>

                <p style="margin:20px 0 0;">We look forward to having you on board!<br />The DiGidot Team</p>

                <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0" />
              <p style="margin:0;color:#9ca3af;font-size:12px;text-align:center;">
                  &copy; 2025 DiGidot. All rights reserved.<br />
                  This is an automated message &ndash; please do not reply.
                </p>              </td>
            </tr>
          </table>


        </td>
      </tr>
    </table>
  </body>
</html>`;
}


async function sendInvitationEmail({
  to, siteId, siteName, roleToAssign, invitationId,
  // NEW optional fields (backwards-compatible)
  inviterName: inviterNameArg,
  inviterEmail,
  inviterUserId,
  inviterSub,
  inviterClaims
}) {
  const fromName  = process.env.FROM_NAME  || "Site Admin";
  const fromEmail = process.env.FROM_EMAIL || process.env.GMAIL_USER;

  // Invitee name (unchanged)
  const inviteeName  = await resolveInviteeName(to);

  // 🔹 NEW: resolve inviter name from any sources you provide; fallback to FROM_NAME
  let inviterName = await resolveInviterName({ inviterNameArg, inviterClaims, inviterUserId, inviterEmail, inviterSub });
  if (!inviterName) inviterName = fromName;

  // Build accept URL (unchanged)
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
  // below details 

  const info = await getTransporter().sendMail({
    from: `"${fromName}" <${fromEmail}>`,
    to,
    subject: `You’ve been invited to join a DiGidot Horizon site`,
    text,
    html,
  });

  return { messageId: info.messageId };
}



module.exports = { sendInvitationEmail };
