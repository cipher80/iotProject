const { DynamoDBClient, PutItemCommand, GetItemCommand, ScanCommand, UpdateItemCommand, BatchGetItemCommand, DeleteItemCommand , QueryCommand } = require("@aws-sdk/client-dynamodb"); const { randomUUID } = require("crypto");

else if (route === "POST /v1/sites/{siteId}/favorite}") {
  const { siteId } = event.pathParameters;

  // Site must exist
  const { Item: site } = await ddb.send(new GetItemCommand({
    TableName: SITES,
    Key: { siteId: { S: siteId } }
  }));
  if (!site) {
    return { statusCode: 404, body: "Site not found" };
  }

  // Non-super must be a member of the site
  if (!isSuper) {
    const isMember = site.members?.L?.some(m => m.M.userId.S === userId);
    if (!isMember) {
      return { statusCode: 403, body: "Forbidden: you are not a member of this site." };
    }
  }

  // Add siteId to user's favoriteSites (String Set). Creates the attr if missing.
  await ddb.send(new UpdateItemCommand({
    TableName: USERS,
    Key: { userId: { S: userId } },
    UpdateExpression: "ADD favoriteSites :sidset",
    ExpressionAttributeValues: { ":sidset": { SS: [ siteId ] } }
  }));

  return {
    statusCode: 201,
    body: JSON.stringify({ message: "Marked as favorite", siteId })
  };
}
else if (route === "GET /v1/sites/favorites") {
  const qs             = event.queryStringParameters || {};
  const includeDevices = qs['include-devices'] === 'true';
  const searchTerm     = (qs.search || "").trim().toLowerCase();
  const page           = Math.max(1, parseInt(qs.page || "1", 10));
  const pageSize       = Math.min(200, Math.max(1, parseInt(qs.pageSize || "20", 10)));

  // Load current user's favorites set from USERS table
  const ures = await ddb.send(new GetItemCommand({
    TableName: USERS,
    Key: { userId: { S: userId } },
    ProjectionExpression: "favoriteSites"
  }));

  // Parse favoriteSites in a tolerant way (SS preferred; also accept L or JSON string)
  const parseFavoriteIds = (attr) => {
    const out = new Set();
    if (!attr) return out;
    if (attr.SS) for (const s of attr.SS) out.add(s);
    else if (attr.L) for (const x of attr.L) { const v = x.S ?? x; if (typeof v === "string") out.add(v); }
    else if (attr.S) {
      try {
        const arr = JSON.parse(attr.S);
        if (Array.isArray(arr)) for (const v of arr) out.add(String(v));
      } catch { out.add(attr.S); }
    }
    return out;
  };

  const favIds = Array.from(parseFavoriteIds(ures.Item?.favoriteSites));
  if (favIds.length === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        items: [],
        meta: { total: 0, page: 1, pageSize, totalPages: 1, hasNextPage: false, hasPrevPage: false }
      })
    };
  }

  // BatchGet all favorite sites
  const sites = [];
  const chunk = (arr,n)=>{const o=[];for(let i=0;i<arr.length;i+=n)o.push(arr.slice(i,i+n));return o;};
  for (const keys of chunk(favIds, 100)) {
    let req = {
      RequestItems: {
        [SITES]: {
          Keys: keys.map(id => ({ siteId: { S: id } }))
        }
      }
    };
    // Handle unprocessed keys (throttling)
    while (true) {
      const resp = await ddb.send(new BatchGetItemCommand(req));
      sites.push(...(resp.Responses?.[SITES] || []));
      const unp = resp.UnprocessedKeys && Object.keys(resp.UnprocessedKeys).length ? resp.UnprocessedKeys : null;
      if (!unp) break;
      await new Promise(r => setTimeout(r, 60));
      req = { RequestItems: unp };
    }
  }

  // Map → filter soft-deleted → enforce membership for non-super → shape
  const mapped = (sites || [])
    .map(item => {
      // Skip soft-deleted
      const isSoftDeleted = item.isDeleted?.BOOL === true || item.isDeleted?.S === "true";
      if (isSoftDeleted) return null;

      const mems = item.members?.L?.map(x => x.M) || [];
      const me   = mems.find(m => m.userId.S === userId);

      if (!isSuper && !me) return null;

      const cfArr = item.customFields?.M
        ? Object.entries(item.customFields.M).map(([k, v]) => ({ key: k, value: v.S }))
        : [];

      const siteObj = {
        siteId:     item.siteId.S,
        siteName:   item.siteName.S,
        clientName: item.clientName.S,
        address:    item.address.S,
        country:    item.country.S,
        city:       item.city.S,
        state:      item.state.S,
        postalCode: item.postalCode.S,
        createdBy:  item.createdBy.S,
        createdAt:  item.createdAt.S,
        role:       isSuper ? "SuperAdmin" : me.role.S,
        assignedAt: isSuper ? null         : me.assignedAt.S,
        customFields: cfArr
      };

      if (includeDevices) {
        Object.assign(siteObj, {
          c4Count:                 Number(item.c4Count?.N || 0),
          smartReceiverCount:      Number(item.smartReceiverCount?.N || 0),
          lightsCount:             Number(item.lightsCount?.N || 0),
          healthScore:             Number(item.healthScore?.N || 0),
          powerConsumption:        Number(item.powerConsumption?.N || 0),
          alertsCount:             Number(item.alertsCount?.N || 0),
          warningsCount:           Number(item.warningsCount?.N || 0),
          deviceDataLastUpdatedAt: item.deviceDataLastUpdatedAt?.S || null
        });
      }

      return siteObj;
    })
    .filter(Boolean);

  // Search by siteName (case-insensitive)
  const searched = searchTerm
    ? mapped.filter(s => (s.siteName || "").toLowerCase().includes(searchTerm))
    : mapped;

  // Sort alpha by siteName
  searched.sort((a, b) => (a.siteName || "").localeCompare((b.siteName || ""), 'en', { sensitivity: 'base' }));

  // Pagination
  const total       = searched.length;
  const totalPages  = Math.max(1, Math.ceil(total / pageSize));
  const safePage    = Math.min(page, totalPages);
  const startIndex  = (safePage - 1) * pageSize;
  const pageItems   = searched.slice(startIndex, startIndex + pageSize);

  // Attach IoT bridge counts (same pattern you use in /v1/sites)
  const itemsWithCounts = await Promise.all(pageItems.map(async (s) => {
    let totalBridges = 0;
    let lekCount;
    do {
      const countRes = await ddb.send(new QueryCommand({
        TableName: IOTBRIDGES_TABLE,
        KeyConditionExpression: "siteId = :sid",
        ExpressionAttributeValues: { ":sid": { S: s.siteId } },
        Select: "COUNT",
        ExclusiveStartKey: lekCount
      }));
      totalBridges += (countRes.Count || 0);
      lekCount = countRes.LastEvaluatedKey;
    } while (lekCount);
    return { ...s, iotBridgeCount: totalBridges };
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({
      items: itemsWithCounts,
      meta: {
        total,
        page: safePage,
        pageSize,
        totalPages,
        hasNextPage: safePage < totalPages,
        hasPrevPage: safePage > 1
      }
    })
  };
}
else if (route === "DELETE /v1/sites/{siteId}/favorite") {
  const { siteId } = event.pathParameters;

  // Best-effort removal from String Set; no-op if not present
  await ddb.send(new UpdateItemCommand({
    TableName: USERS,
    Key: { userId: { S: userId } },
    UpdateExpression: "DELETE favoriteSites :sidset",
    ExpressionAttributeValues: { ":sidset": { SS: [ siteId ] } }
  }));

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Unmarked favorite", siteId })
  };
}
