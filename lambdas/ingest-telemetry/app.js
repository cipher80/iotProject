// Simple GET handler to fetch latest device row
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";

const ddb = new DynamoDBClient({
  endpoint: process.env.DDB_ENDPOINT || "http://localhost:4566",
  region: process.env.AWS_REGION || "us-east-1",
  credentials: { accessKeyId: "test", secretAccessKey: "test" },
});

export const handler = async (event) => {
  const deviceId = event?.queryStringParameters?.deviceId || "dev-001";
  const res = await ddb.send(new QueryCommand({
    TableName: process.env.TABLE || "Telemetry",
    KeyConditionExpression: "deviceId = :d",
    ExpressionAttributeValues: { ":d": { S: deviceId } },
    ScanIndexForward: false,
    Limit: 1,
  }));
  return { statusCode: 200, body: JSON.stringify(res.Items?.[0] || null) };
};
