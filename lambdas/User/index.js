const {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
  DescribeTableCommand,
} = require("@aws-sdk/client-dynamodb");

const ddb = new DynamoDBClient({
  region: process.env.AWS_REGION || "eu-north-1",
});
const TABLE = process.env.SIGNED_UP_TABLE;

async function resolveRegion() {
  const r = ddb.config.region;
  return typeof r === "function" ? await r() : r;
}

let _tableInfo = null;
async function ensureTableShape() {
  if (_tableInfo) return _tableInfo;
  if (!TABLE) {
    console.error("SIGNED_UP_TABLE env var is not set.");
    _tableInfo = { ok: false, reason: "NO_TABLE_NAME" };
    return _tableInfo;
  }
  try {
    const out = await ddb.send(new DescribeTableCommand({ TableName: TABLE }));
    const t = out?.Table;
    const keySchema = t?.KeySchema || [];
    const attrDefs = t?.AttributeDefinitions || [];
    const hash = keySchema.find((k) => k.KeyType === "HASH");
    const attr = attrDefs.find((a) => a.AttributeName === (hash && hash.AttributeName));
    const info = {
      ok: true,
      tableArn: t?.TableArn,
      region: await resolveRegion(),
      keyName: hash?.AttributeName,
      keyType: attr?.AttributeType,
      itemCount: t?.ItemCount,
    };
    console.info("[DDB] Table inspected:", info);
    _tableInfo = info;
    return _tableInfo;
  } catch (e) {
    console.error("[DDB] DescribeTable failed:", {
      table: TABLE, region: await resolveRegion(), error: e.message
    });
    _tableInfo = { ok: false, reason: "DESCRIBE_FAILED", error: e };
    return _tableInfo;
  }
}


exports.handler = async (event) => {
  console.info("EVENT ▶", JSON.stringify(event, null, 2));

  // Authorizer (HTTP API v2) + local fallback
  let claims = event.requestContext?.authorizer?.jwt?.claims || {};
  const token = event.headers?.authorization || event.headers?.Authorization;
  if ((!claims || Object.keys(claims).length === 0) && token?.startsWith("Bearer ")) {
    try {
      const raw = token.split(" ")[1];
      const payload = JSON.parse(Buffer.from(raw.split(".")[1], "base64").toString("utf8"));
      claims = {
        ...claims,
        sub: payload.sub || payload.username || payload["cognito:username"],
        token_use: payload.token_use
      };
    } catch (e) {
      console.warn("JWT decode failed (local fallback). Proceeding without claims.", e.message);
    }
  }

  const userId =
    claims?.sub ||
    claims?.username ||
    claims?.["cognito:username"];

  if (!userId) {
    console.warn("No suitable user claim on token", { claimKeys: Object.keys(claims || {}) });
    return { statusCode: 401, body: "Unauthorized" };
  }

  const userKeyValue = String(userId).trim();
  const key = { userId: { S: userKeyValue } };

  const shape = await ensureTableShape();
  if (!shape.ok) {
    console.warn("[DDB] Proceeding despite table shape check not OK:", shape);
  } else if (shape.keyName !== "userId" || shape.keyType !== "S") {
    console.error(
      `[DDB] Table PK mismatch. Expected userId(S), got ${shape.keyName}(${shape.keyType}).`,
      { table: TABLE, region: shape.region }
    );
  }

  const routeKey = event.requestContext?.routeKey; // e.g. "GET /v1/users/profile"
  try {
    if (routeKey === "GET /v1/users/profile") {
      const { Item } = await ddb.send(new GetItemCommand({
        TableName: TABLE, Key: key, ConsistentRead: true
      }));
      if (!Item) {
        console.warn("[DDB] User not found", {
          table: TABLE, region: await resolveRegion(), keySent: key, token_use: claims?.token_use
        });
        return { statusCode: 404, body: "User not found" };
      }
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: userKeyValue,
          email: Item.email?.S,
          createdAt: Item.createdAt?.S || Item.timestamp?.S,
          company: Item.companyName?.S || null,
        }),
      };

    } 
    return { statusCode: 404, body: "Not Found" };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: err.message }) };
  }
};