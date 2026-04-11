const crypto = require('crypto');
const express = require('express');
const Ably = require('ably');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;

const CHAT_ENGINE_JWT_SECRET = process.env.CHAT_ENGINE_JWT_SECRET || '';
const CHAT_ENGINE_JWT_ALG = process.env.CHAT_ENGINE_JWT_ALG || 'HS256';
const CHAT_ENGINE_API_KEY = process.env.CHAT_ENGINE_API_KEY || '';
const ALLOW_LEGACY_API_KEY = (process.env.ALLOW_LEGACY_API_KEY || 'false').toLowerCase() === 'true';
const ENABLE_PUBLIC_CHAT_DEMO = (process.env.ENABLE_PUBLIC_CHAT_DEMO || 'false').toLowerCase() === 'true';
const DEMO_ABLY_API_KEY = process.env.ABLY_API_KEY || '';
const DEMO_CHANNEL = process.env.CHAT_DEFAULT_CHANNEL || 'global-chat';

app.use(express.json());

const diagnostics = {
  startedAt: Date.now(),
  requestCount: 0,
  totalInBytes: 0,
  totalOutBytes: 0,
  totalLatencyMs: 0,
  statusBuckets: {},
  latencySamples: [],
  recent: []
};

function bytesFromContentLength(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function percentile(samples, pct) {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  const reqBytes = bytesFromContentLength(req.headers['content-length']);

  res.on('finish', () => {
    const latencyMs = Number(process.hrtime.bigint() - started) / 1000000;
    const outBytes = bytesFromContentLength(res.getHeader('content-length'));
    const status = String(res.statusCode);

    diagnostics.requestCount += 1;
    diagnostics.totalInBytes += reqBytes;
    diagnostics.totalOutBytes += outBytes;
    diagnostics.totalLatencyMs += latencyMs;
    diagnostics.statusBuckets[status] = (diagnostics.statusBuckets[status] || 0) + 1;
    diagnostics.latencySamples.push(latencyMs);
    if (diagnostics.latencySamples.length > 2000) diagnostics.latencySamples.shift();

    diagnostics.recent.push({
      at: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.url,
      status: res.statusCode,
      latency_ms: Number(latencyMs.toFixed(2)),
      in_bytes: reqBytes,
      out_bytes: outBytes,
      ip: req.ip
    });
    if (diagnostics.recent.length > 120) diagnostics.recent.shift();
  });

  next();
});

const dbPoolCache = new Map();
const tableExistsCache = new Map();
const ablyClientCache = new Map();

const defaultSchema = {
  adapter: 'laravel_chat_v1',
  tables: {
    api_credentials: 'api_credentials',
    conversations: 'chat_conversations',
    participants: 'chat_participants',
    messages: 'chat_messages',
    users: 'users'
  },
  fields: {
    api_name: 'api_name',
    key_name: 'key_name',
    key_value: 'key_value',
    deleted_at: 'deleted_at',
    conversation_id: 'conversation_id',
    user_id: 'user_id',
    body: 'body',
    created_at: 'created_at',
    updated_at: 'updated_at',
    message_id: 'id',
    user_name: 'name'
  },
  options: {
    ably_api_name: 'ably',
    ably_key_name: null,
    channel_prefix: 'chat:conversation:'
  }
};

function parseBearerToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return '';
}

function safeString(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function clampLimit(input, fallback = 30) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.floor(n)));
}

function mergeSchema(schemaPayload) {
  const schema = schemaPayload && typeof schemaPayload === 'object' ? schemaPayload : {};

  return {
    adapter: safeString(schema.adapter, defaultSchema.adapter),
    tables: { ...defaultSchema.tables, ...(schema.tables || {}) },
    fields: { ...defaultSchema.fields, ...(schema.fields || {}) },
    options: { ...defaultSchema.options, ...(schema.options || {}) }
  };
}

function requireTenantContext(req, res, next) {
  const token = parseBearerToken(req) || safeString(req.headers['x-chat-engine-token']);

  if (!token && ALLOW_LEGACY_API_KEY && CHAT_ENGINE_API_KEY) {
    const apiKey = safeString(req.headers['x-api-key']);
    if (apiKey && apiKey === CHAT_ENGINE_API_KEY) {
      req.tenantContext = {
        mode: 'legacy_api_key',
        tenantId: safeString(req.headers['x-tenant-id']) || 'legacy',
        requestUserId: Number(req.headers['x-user-id']) || null,
        db: {
          host: process.env.DB_HOST || '',
          port: Number(process.env.DB_PORT || 3306),
          database: process.env.DB_DATABASE || '',
          username: process.env.DB_USERNAME || '',
          password: process.env.DB_PASSWORD || ''
        },
        schema: mergeSchema({})
      };
      return next();
    }
  }

  if (!token) {
    return res.status(401).json({ error: 'Missing Laravel service token.' });
  }

  if (!CHAT_ENGINE_JWT_SECRET) {
    return res.status(500).json({ error: 'CHAT_ENGINE_JWT_SECRET is missing on server.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, CHAT_ENGINE_JWT_SECRET, { algorithms: [CHAT_ENGINE_JWT_ALG] });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid tenant token.' });
  }

  const db = payload.db || {};
  const tenantId = safeString(payload.tenant_id);

  if (!tenantId) {
    return res.status(400).json({ error: 'Token is missing tenant_id.' });
  }

  if (!db.host || !db.database || !db.username) {
    return res.status(400).json({ error: 'Token is missing db connection details.' });
  }

  req.tenantContext = {
    mode: 'laravel_jwt',
    tenantId,
    requestUserId: Number(payload.user_id) || null,
    db: {
      host: safeString(db.host),
      port: Number(db.port || 3306),
      database: safeString(db.database),
      username: safeString(db.username),
      password: safeString(db.password)
    },
    schema: mergeSchema(payload.schema),
    traceId: safeString(payload.trace_id)
  };

  next();
}

function getPoolKey(ctx) {
  const db = ctx.db;
  return `${db.host}:${db.port}:${db.database}:${db.username}`;
}

async function getTenantPool(ctx) {
  const key = getPoolKey(ctx);
  if (dbPoolCache.has(key)) return dbPoolCache.get(key);

  const pool = mysql.createPool({
    host: ctx.db.host,
    port: ctx.db.port,
    user: ctx.db.username,
    password: ctx.db.password,
    database: ctx.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });

  dbPoolCache.set(key, pool);
  return pool;
}

async function tableExists(pool, database, tableName) {
  const cacheKey = `${database}.${tableName}`;
  if (tableExistsCache.has(cacheKey)) return tableExistsCache.get(cacheKey);

  const [rows] = await pool.query(
    'SELECT 1 AS ok FROM information_schema.tables WHERE table_schema = ? AND table_name = ? LIMIT 1',
    [database, tableName]
  );

  const exists = rows.length > 0;
  tableExistsCache.set(cacheKey, exists);
  return exists;
}

async function findTenantAblyKey(pool, ctx) {
  const { tables, fields, options } = ctx.schema;
  const hasApiTable = await tableExists(pool, ctx.db.database, tables.api_credentials);
  if (!hasApiTable) return null;

  let sql = `
    SELECT ${fields.key_value} AS key_value
    FROM ${tables.api_credentials}
    WHERE ${fields.api_name} = ?
      AND (${fields.deleted_at} IS NULL)
  `;

  const params = [options.ably_api_name];

  if (options.ably_key_name) {
    sql += ` AND ${fields.key_name} = ?`;
    params.push(options.ably_key_name);
  }

  sql += ' ORDER BY id DESC LIMIT 1';

  const [rows] = await pool.query(sql, params);
  if (!rows.length) return null;
  return safeString(rows[0].key_value) || null;
}

function getAblyClientForKey(apiKey) {
  if (!apiKey) return null;
  if (ablyClientCache.has(apiKey)) return ablyClientCache.get(apiKey);

  const client = new Ably.Rest(apiKey);
  ablyClientCache.set(apiKey, client);
  return client;
}

function buildChannelName(ctx, conversationId) {
  return `${ctx.schema.options.channel_prefix}${conversationId}`;
}

async function assertParticipant(pool, ctx, conversationId, userId) {
  const { tables, fields } = ctx.schema;
  const [rows] = await pool.query(
    `SELECT 1 AS ok
     FROM ${tables.participants}
     WHERE ${fields.conversation_id} = ?
       AND ${fields.user_id} = ?
       AND ${fields.deleted_at} IS NULL
     LIMIT 1`,
    [conversationId, userId]
  );

  return rows.length > 0;
}

async function saveMessage(pool, ctx, payload) {
  const { tables, fields } = ctx.schema;

  const [result] = await pool.query(
    `INSERT INTO ${tables.messages}
      (${fields.conversation_id}, ${fields.user_id}, ${fields.body}, ${fields.created_at}, ${fields.updated_at})
     VALUES (?, ?, ?, NOW(), NOW())`,
    [payload.conversationId, payload.userId, payload.text]
  );

  return Number(result.insertId);
}

async function getMessageById(pool, ctx, messageId) {
  const { tables, fields } = ctx.schema;

  const [rows] = await pool.query(
    `SELECT
      ${fields.message_id} AS message_id,
      ${fields.conversation_id} AS conversation_id,
      ${fields.user_id} AS user_id,
      ${fields.body} AS body,
      ${fields.created_at} AS created_at
     FROM ${tables.messages}
     WHERE ${fields.message_id} = ?
     LIMIT 1`,
    [messageId]
  );

  return rows.length ? rows[0] : null;
}

async function fetchHistory(pool, ctx, conversationId, limit) {
  const { tables, fields } = ctx.schema;
  const hasUsers = await tableExists(pool, ctx.db.database, tables.users);

  if (hasUsers) {
    const [rows] = await pool.query(
      `SELECT
        m.${fields.message_id} AS message_id,
        m.${fields.conversation_id} AS conversation_id,
        m.${fields.user_id} AS user_id,
        m.${fields.body} AS body,
        m.${fields.created_at} AS created_at,
        u.${fields.user_name} AS user_name
       FROM ${tables.messages} m
       LEFT JOIN ${tables.users} u ON u.id = m.${fields.user_id}
       WHERE m.${fields.conversation_id} = ?
         AND m.${fields.deleted_at} IS NULL
       ORDER BY m.${fields.message_id} DESC
       LIMIT ?`,
      [conversationId, limit]
    );

    return rows.reverse();
  }

  const [rows] = await pool.query(
    `SELECT
      ${fields.message_id} AS message_id,
      ${fields.conversation_id} AS conversation_id,
      ${fields.user_id} AS user_id,
      ${fields.body} AS body,
      ${fields.created_at} AS created_at,
      NULL AS user_name
     FROM ${tables.messages}
     WHERE ${fields.conversation_id} = ?
       AND ${fields.deleted_at} IS NULL
     ORDER BY ${fields.message_id} DESC
     LIMIT ?`,
    [conversationId, limit]
  );

  return rows.reverse();
}

async function publishRealtime(ablyApiKey, channelName, messagePayload) {
  if (!ablyApiKey) return;
  const client = getAblyClientForKey(ablyApiKey);
  if (!client) return;
  const channel = client.channels.get(channelName);
  await channel.publish('message', messagePayload);
}

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Tenant Chat Engine</title>
</head>
<body>
  <h1>Tenant Chat Engine API</h1>
  <p>Use Laravel signed tenant tokens for API calls.</p>
  <ul>
    <li><a href="/health">/health</a></li>
    <li><a href="/chat">/chat demo</a></li>
    <li><a href="/diag">/diag diagnostics</a></li>
  </ul>
</body>
</html>`;
}

function renderChatPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chat Demo</title>
</head>
<body>
  <h2>Public demo is optional and disabled by default.</h2>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.send(renderHomePage());
});

app.get('/chat', (req, res) => {
  res.send(renderChatPage());
});

app.get('/api/diag/summary', (req, res) => {
  const uptimeSec = Math.floor((Date.now() - diagnostics.startedAt) / 1000);
  const avgLatency = diagnostics.requestCount
    ? diagnostics.totalLatencyMs / diagnostics.requestCount
    : 0;

  return res.json({
    status: 'ok',
    uptime_sec: uptimeSec,
    started_at: new Date(diagnostics.startedAt).toISOString(),
    request_count: diagnostics.requestCount,
    transfer: {
      in_bytes: diagnostics.totalInBytes,
      out_bytes: diagnostics.totalOutBytes
    },
    latency: {
      avg_ms: Number(avgLatency.toFixed(2)),
      p50_ms: Number(percentile(diagnostics.latencySamples, 50).toFixed(2)),
      p95_ms: Number(percentile(diagnostics.latencySamples, 95).toFixed(2))
    },
    statuses: diagnostics.statusBuckets,
    memory: process.memoryUsage(),
    recent: diagnostics.recent.slice(-30)
  });
});

app.get('/api/diag/ping', (req, res) => {
  res.json({ status: 'ok', now: Date.now() });
});

app.get('/diag', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chat Engine Diagnostics</title>
  <style>
    :root { --bg:#0b1220; --panel:#111a2d; --card:#16223b; --text:#e8eefc; --muted:#99a8c7; --ok:#39d98a; }
    body { margin:0; font-family:Segoe UI,system-ui,-apple-system,sans-serif; background:linear-gradient(120deg,#0b1220,#121f35); color:var(--text); }
    .wrap { max-width:1100px; margin:24px auto; padding:0 16px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
    .card { background:var(--card); border-radius:10px; padding:14px; }
    .k { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.08em; }
    .v { font-size:24px; margin-top:6px; font-weight:700; }
    .table { width:100%; border-collapse:collapse; margin-top:14px; }
    th,td { border-bottom:1px solid #233252; padding:8px 6px; font-size:13px; text-align:left; }
    .pill { display:inline-block; background:#223154; color:#bcd0f7; padding:2px 8px; border-radius:999px; font-size:12px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Node Chat Diagnostics</h1>
    <p class="k">Live troubleshooting for ping, transfer volume, status codes, and recent API traffic.</p>
    <div class="grid">
      <div class="card"><div class="k">Ping</div><div class="v" id="ping">-</div></div>
      <div class="card"><div class="k">Requests</div><div class="v" id="requests">-</div></div>
      <div class="card"><div class="k">Avg Latency</div><div class="v" id="latency">-</div></div>
      <div class="card"><div class="k">In / Out</div><div class="v" id="transfer">-</div></div>
    </div>
    <h3>Recent Traffic</h3>
    <table class="table">
      <thead><tr><th>Time</th><th>Method</th><th>Path</th><th>Status</th><th>Latency</th><th>In</th><th>Out</th></tr></thead>
      <tbody id="rows"><tr><td colspan="7">Loading...</td></tr></tbody>
    </table>
  </div>
  <script>
    const fmtBytes = (n) => {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / (1024 * 1024)).toFixed(2) + ' MB';
    };

    async function poll() {
      const t0 = performance.now();
      const pingRes = await fetch('/api/diag/ping', { cache: 'no-store' });
      await pingRes.json();
      const pingMs = Math.round(performance.now() - t0);

      const res = await fetch('/api/diag/summary', { cache: 'no-store' });
      const data = await res.json();

      document.getElementById('ping').textContent = pingMs + ' ms';
      document.getElementById('requests').textContent = String(data.request_count || 0);
      document.getElementById('latency').textContent = (data.latency?.avg_ms ?? 0) + ' ms';
      document.getElementById('transfer').textContent = fmtBytes(data.transfer?.in_bytes || 0) + ' / ' + fmtBytes(data.transfer?.out_bytes || 0);

      const rows = (data.recent || []).slice().reverse().map((r) => (
        '<tr>' +
        '<td>' + (r.at || '-') + '</td>' +
        '<td><span class="pill">' + (r.method || '-') + '</span></td>' +
        '<td>' + (r.path || '-') + '</td>' +
        '<td>' + (r.status || '-') + '</td>' +
        '<td>' + (r.latency_ms || 0) + ' ms</td>' +
        '<td>' + fmtBytes(r.in_bytes || 0) + '</td>' +
        '<td>' + fmtBytes(r.out_bytes || 0) + '</td>' +
        '</tr>'
      )).join('');
      document.getElementById('rows').innerHTML = rows || '<tr><td colspan="7">No traffic yet</td></tr>';
    }

    poll().catch(() => {});
    setInterval(() => poll().catch(() => {}), 3000);
  </script>
</body>
</html>`);
});

app.get('/api/ably-token', async (req, res) => {
  if (!ENABLE_PUBLIC_CHAT_DEMO) {
    return res.status(403).json({ error: 'Public chat demo is disabled.' });
  }

  if (!DEMO_ABLY_API_KEY) {
    return res.status(500).json({ error: 'ABLY_API_KEY is missing on server for demo mode.' });
  }

  const clientId = safeString(req.query.clientId) || `demo-${Date.now()}`;
  const client = getAblyClientForKey(DEMO_ABLY_API_KEY);

  try {
    const tokenRequest = await client.auth.createTokenRequest({
      clientId,
      capability: JSON.stringify({ [DEMO_CHANNEL]: ['publish', 'subscribe', 'presence', 'history'] })
    });

    return res.json(tokenRequest);
  } catch {
    return res.status(500).json({ error: 'Failed to create demo token request.' });
  }
});

app.post('/api/chat/messages', requireTenantContext, async (req, res) => {
  const ctx = req.tenantContext;
  const conversationId = Number(req.body.conversation_id);
  const userId = Number(req.body.user_id || ctx.requestUserId);
  const text = safeString(req.body.text).trim();

  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({ error: 'conversation_id is required.' });
  }

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'user_id is required.' });
  }

  if (!text) {
    return res.status(400).json({ error: 'text is required.' });
  }

  try {
    const pool = await getTenantPool(ctx);
    const isParticipant = await assertParticipant(pool, ctx, conversationId, userId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'User is not a participant in this conversation.' });
    }

    const messageId = await saveMessage(pool, ctx, { conversationId, userId, text });
    const row = await getMessageById(pool, ctx, messageId);

    const channelName = buildChannelName(ctx, conversationId);
    const ablyApiKey = await findTenantAblyKey(pool, ctx);

    const eventPayload = {
      tenant_id: ctx.tenantId,
      conversation_id: conversationId,
      message_id: row ? row.message_id : messageId,
      user_id: row ? row.user_id : userId,
      body: row ? row.body : text,
      created_at: row ? row.created_at : new Date().toISOString(),
      channel: channelName
    };

    await publishRealtime(ablyApiKey, channelName, eventPayload);

    return res.status(201).json({
      ok: true,
      tenant_id: ctx.tenantId,
      channel: channelName,
      message: eventPayload
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create message.' });
  }
});

app.get('/api/chat/history', requireTenantContext, async (req, res) => {
  const ctx = req.tenantContext;
  const conversationId = Number(req.query.conversation_id);
  const userId = Number(req.query.user_id || ctx.requestUserId);
  const limit = clampLimit(req.query.limit, 30);

  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    return res.status(400).json({ error: 'conversation_id is required.' });
  }

  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ error: 'user_id is required.' });
  }

  try {
    const pool = await getTenantPool(ctx);
    const isParticipant = await assertParticipant(pool, ctx, conversationId, userId);
    if (!isParticipant) {
      return res.status(403).json({ error: 'User is not a participant in this conversation.' });
    }

    const messages = await fetchHistory(pool, ctx, conversationId, limit);

    return res.json({
      tenant_id: ctx.tenantId,
      conversation_id: conversationId,
      channel: buildChannelName(ctx, conversationId),
      count: messages.length,
      messages
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to load history.' });
  }
});

app.get('/api/chat/health', requireTenantContext, async (req, res) => {
  const ctx = req.tenantContext;

  try {
    const pool = await getTenantPool(ctx);
    await pool.query('SELECT 1');

    const hasConversations = await tableExists(pool, ctx.db.database, ctx.schema.tables.conversations);
    const hasParticipants = await tableExists(pool, ctx.db.database, ctx.schema.tables.participants);
    const hasMessages = await tableExists(pool, ctx.db.database, ctx.schema.tables.messages);
    const hasApiCredentials = await tableExists(pool, ctx.db.database, ctx.schema.tables.api_credentials);

    return res.json({
      status: 'ok',
      tenant_id: ctx.tenantId,
      auth_mode: ctx.mode,
      schema_adapter: ctx.schema.adapter,
      db: {
        host: ctx.db.host,
        database: ctx.db.database,
        connected: true,
        tables: {
          conversations: hasConversations,
          participants: hasParticipants,
          messages: hasMessages,
          api_credentials: hasApiCredentials
        }
      }
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Tenant DB health check failed.' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
