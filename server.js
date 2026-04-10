const crypto = require('crypto');
const express = require('express');
const Ably = require('ably');
const mysql = require('mysql2/promise');

const app = express();
const PORT = process.env.PORT || 3000;
const ABLY_API_KEY = process.env.ABLY_API_KEY || '';
const CHAT_ENGINE_API_KEY = process.env.CHAT_ENGINE_API_KEY || '';
const DEFAULT_CHANNEL = process.env.CHAT_DEFAULT_CHANNEL || 'global-chat';
const ENABLE_PUBLIC_CHAT_DEMO = (process.env.ENABLE_PUBLIC_CHAT_DEMO || 'true').toLowerCase() === 'true';
const CHAT_MESSAGES_TABLE = process.env.CHAT_MESSAGES_TABLE || 'chat_messages';
const CHAT_AUTO_CREATE_TABLE = (process.env.CHAT_AUTO_CREATE_TABLE || 'true').toLowerCase() === 'true';

const DB_HOST = process.env.DB_HOST || '';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_DATABASE = process.env.DB_DATABASE || '';
const DB_USERNAME = process.env.DB_USERNAME || '';
const DB_PASSWORD = process.env.DB_PASSWORD || '';

app.use(express.json());

let dbPool = null;

function hasDbConfig() {
  return Boolean(DB_HOST && DB_DATABASE && DB_USERNAME);
}

async function getDbPool() {
  if (!hasDbConfig()) return null;
  if (dbPool) return dbPool;

  dbPool = mysql.createPool({
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USERNAME,
    password: DB_PASSWORD,
    database: DB_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    charset: 'utf8mb4'
  });

  if (CHAT_AUTO_CREATE_TABLE) {
    await ensureMessagesTable();
  }

  return dbPool;
}

async function ensureMessagesTable() {
  const pool = await getDbPool();
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${CHAT_MESSAGES_TABLE} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      tenant_id VARCHAR(64) NULL,
      message_id VARCHAR(64) NOT NULL,
      channel_name VARCHAR(100) NOT NULL,
      user_id VARCHAR(64) NOT NULL,
      user_name VARCHAR(120) NOT NULL,
      message_text TEXT NOT NULL,
      meta_json JSON NULL,
      created_at BIGINT UNSIGNED NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_message_id (message_id),
      KEY idx_channel_created (channel_name, created_at),
      KEY idx_tenant_channel_created (tenant_id, channel_name, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function getAblyClient() {
  if (!ABLY_API_KEY) return null;
  return new Ably.Rest(ABLY_API_KEY);
}

function parseEngineKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string') return xApiKey.trim();
  return '';
}

function requireEngineKey(req, res, next) {
  if (!CHAT_ENGINE_API_KEY) {
    return res.status(500).json({ error: 'CHAT_ENGINE_API_KEY is missing on the server.' });
  }

  const provided = parseEngineKey(req);
  if (!provided) {
    return res.status(401).json({ error: 'Missing API key. Use Authorization: Bearer <CHAT_ENGINE_API_KEY>.' });
  }

  if (provided !== CHAT_ENGINE_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key.' });
  }

  next();
}

function clampLimit(input, fallback = 30) {
  const n = Number(input);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), 1), 100);
}

function getTenantId(req) {
  const tenant = req.headers['x-tenant-id'];
  if (typeof tenant !== 'string') return null;
  const clean = tenant.trim();
  return clean || null;
}

async function publishMessage(channelName, payload) {
  const client = getAblyClient();
  if (!client) {
    throw new Error('ABLY_API_KEY is missing on the server.');
  }

  const channel = client.channels.get(channelName);
  await channel.publish('message', payload);
}

async function createTokenRequest({ clientId, channels }) {
  const client = getAblyClient();
  if (!client) {
    throw new Error('ABLY_API_KEY is missing on the server.');
  }

  const safeChannels = Array.isArray(channels) && channels.length ? channels : [DEFAULT_CHANNEL];
  const capability = {};
  for (const channel of safeChannels) {
    capability[channel] = ['publish', 'subscribe', 'presence', 'history'];
  }

  return client.auth.createTokenRequest({
    clientId,
    capability: JSON.stringify(capability)
  });
}

async function saveMessageToDb(message) {
  const pool = await getDbPool();
  if (!pool) return false;

  await pool.query(
    `INSERT INTO ${CHAT_MESSAGES_TABLE}
      (tenant_id, message_id, channel_name, user_id, user_name, message_text, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
      user_name = VALUES(user_name),
      message_text = VALUES(message_text),
      meta_json = VALUES(meta_json),
      created_at = VALUES(created_at)`,
    [
      message.tenantId,
      message.messageId,
      message.channel,
      message.userId,
      message.userName,
      message.text,
      message.meta ? JSON.stringify(message.meta) : null,
      message.ts
    ]
  );

  return true;
}

async function fetchHistoryFromDb({ tenantId, channelName, limit }) {
  const pool = await getDbPool();
  if (!pool) return null;

  let rows;
  if (tenantId) {
    [rows] = await pool.query(
      `SELECT tenant_id, message_id, channel_name, user_id, user_name, message_text, meta_json, created_at
       FROM ${CHAT_MESSAGES_TABLE}
       WHERE tenant_id = ? AND channel_name = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [tenantId, channelName, limit]
    );
  } else {
    [rows] = await pool.query(
      `SELECT tenant_id, message_id, channel_name, user_id, user_name, message_text, meta_json, created_at
       FROM ${CHAT_MESSAGES_TABLE}
       WHERE channel_name = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [channelName, limit]
    );
  }

  return rows
    .reverse()
    .map((row) => ({
      tenantId: row.tenant_id,
      messageId: row.message_id,
      channel: row.channel_name,
      userId: row.user_id,
      userName: row.user_name,
      text: row.message_text,
      meta: row.meta_json || null,
      ts: Number(row.created_at)
    }));
}

async function fetchHistoryFromAbly(channelName, limit) {
  const client = getAblyClient();
  if (!client) return [];

  const channel = client.channels.get(channelName);

  const page = await new Promise((resolve, reject) => {
    channel.history({ limit, direction: 'backwards' }, (err, resultPage) => {
      if (err) return reject(err);
      return resolve(resultPage);
    });
  });

  return (page.items || [])
    .map((item) => item.data)
    .filter(Boolean)
    .reverse();
}

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Chat Engine API</title>
  <style>
    :root { --bg-1: #0f172a; --bg-2: #1e293b; --text: #e2e8f0; --accent: #22d3ee; --accent-2: #34d399; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: "Segoe UI", sans-serif; color: var(--text); background:
      radial-gradient(circle at 15% 20%, #0ea5e9 0%, transparent 40%),
      radial-gradient(circle at 85% 80%, #10b981 0%, transparent 35%),
      linear-gradient(135deg, var(--bg-1), var(--bg-2)); }
    .card { width: min(760px, 92vw); padding: 32px 28px; border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 18px; background: rgba(15, 23, 42, 0.78); text-align: center; }
    .row { margin-top: 18px; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
    .chip { display: inline-block; padding: 8px 12px; border-radius: 999px; font-size: 0.85rem; color: #06202a; background: linear-gradient(90deg, var(--accent), var(--accent-2)); font-weight: 700; text-decoration: none; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Node Chat Engine + Laravel Tenant DB</h1>
    <p>API is ready for Laravel integration.</p>
    <div class="row">
      <a class="chip" href="/chat">Open Demo Chat UI</a>
      <a class="chip" href="/health">Service Health</a>
    </div>
  </main>
</body>
</html>`;
}

function renderChatPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Ably Chat Demo</title>
</head>
<body>
  <h2>Ably Chat Demo</h2>
  <p>Use Laravel-issued tokens for production; this is only for demo.</p>
  <script src="https://cdn.ably.com/lib/ably.min-1.js"></script>
  <script>
    console.log('Demo UI available at /chat');
  </script>
</body>
</html>`;
}

app.get('/', (req, res) => {
  res.send(renderHomePage());
});

app.get('/chat', (req, res) => {
  res.send(renderChatPage());
});

app.get('/api/ably-token', async (req, res) => {
  if (!ENABLE_PUBLIC_CHAT_DEMO) {
    return res.status(403).json({ error: 'Public chat demo is disabled.' });
  }

  if (!ABLY_API_KEY) {
    return res.status(500).json({ error: 'ABLY_API_KEY is missing on the server.' });
  }

  try {
    const requestedId = String(req.query.clientId || '').trim();
    const clientId = requestedId || `demo-${Date.now()}`;
    const tokenRequest = await createTokenRequest({ clientId, channels: [DEFAULT_CHANNEL] });
    return res.json(tokenRequest);
  } catch {
    return res.status(500).json({ error: 'Failed to create demo token request.' });
  }
});

app.post('/api/chat/messages', requireEngineKey, async (req, res) => {
  const { channel, userId, userName, text, meta } = req.body || {};
  const channelName = String(channel || DEFAULT_CHANNEL).trim();
  const tenantId = getTenantId(req);

  if (!userId || !userName || !text) {
    return res.status(400).json({ error: 'userId, userName, and text are required.' });
  }

  const message = {
    tenantId,
    messageId: crypto.randomUUID(),
    channel: channelName,
    userId: String(userId),
    userName: String(userName).trim(),
    text: String(text).trim(),
    meta: meta || null,
    ts: Date.now()
  };

  if (!message.text) {
    return res.status(400).json({ error: 'Message text cannot be empty.' });
  }

  try {
    await publishMessage(channelName, message);
    await saveMessageToDb(message);
    return res.status(201).json({ ok: true, message });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to publish message.' });
  }
});

app.get('/api/chat/history', requireEngineKey, async (req, res) => {
  const channelName = String(req.query.channel || DEFAULT_CHANNEL).trim();
  const limit = clampLimit(req.query.limit, 30);
  const tenantId = getTenantId(req);

  try {
    const dbMessages = await fetchHistoryFromDb({ tenantId, channelName, limit });
    const messages = dbMessages || (await fetchHistoryFromAbly(channelName, limit));
    return res.json({ channel: channelName, tenantId, messages, count: messages.length });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch chat history.' });
  }
});

app.get('/api/chat/health', requireEngineKey, async (req, res) => {
  let dbReady = false;
  try {
    const pool = await getDbPool();
    dbReady = Boolean(pool);
  } catch {
    dbReady = false;
  }

  res.json({
    status: 'ok',
    engine: 'node-ably',
    defaultChannel: DEFAULT_CHANNEL,
    hasAblyKey: Boolean(ABLY_API_KEY),
    db: {
      enabled: hasDbConfig(),
      ready: dbReady,
      database: DB_DATABASE || null,
      table: CHAT_MESSAGES_TABLE
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
