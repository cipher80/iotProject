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


