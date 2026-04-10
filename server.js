const crypto = require('crypto');
const express = require('express');
const Ably = require('ably');

const app = express();
const PORT = process.env.PORT || 3000;
const ABLY_API_KEY = process.env.ABLY_API_KEY || '';
const CHAT_ENGINE_API_KEY = process.env.CHAT_ENGINE_API_KEY || '';
const DEFAULT_CHANNEL = process.env.CHAT_DEFAULT_CHANNEL || 'global-chat';
const ENABLE_PUBLIC_CHAT_DEMO = (process.env.ENABLE_PUBLIC_CHAT_DEMO || 'true').toLowerCase() === 'true';

app.use(express.json());

const memoryHistory = new Map();

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

function pushMemoryMessage(channel, message) {
  const current = memoryHistory.get(channel) || [];
  current.push(message);
  const trimmed = current.slice(-100);
  memoryHistory.set(channel, trimmed);
}

function getMemoryHistory(channel, limit) {
  return (memoryHistory.get(channel) || []).slice(-limit);
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

async function fetchHistory(channelName, limit) {
  const client = getAblyClient();
  if (!client) {
    return getMemoryHistory(channelName, limit);
  }

  const channel = client.channels.get(channelName);

  const page = await new Promise((resolve, reject) => {
    channel.history({ limit, direction: 'backwards' }, (err, resultPage) => {
      if (err) return reject(err);
      return resolve(resultPage);
    });
  });

  const items = (page.items || [])
    .map((item) => item.data)
    .filter(Boolean)
    .reverse();

  return items;
}

function renderHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hostinger Node App</title>
  <style>
    :root {
      --bg-1: #0f172a;
      --bg-2: #1e293b;
      --card: rgba(15, 23, 42, 0.78);
      --text: #e2e8f0;
      --accent: #22d3ee;
      --accent-2: #34d399;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 15% 20%, #0ea5e9 0%, transparent 40%),
        radial-gradient(circle at 85% 80%, #10b981 0%, transparent 35%),
        linear-gradient(135deg, var(--bg-1), var(--bg-2));
    }
    .card {
      width: min(760px, 92vw);
      padding: 32px 28px;
      border: 1px solid rgba(148, 163, 184, 0.3);
      border-radius: 18px;
      background: var(--card);
      backdrop-filter: blur(4px);
      box-shadow: 0 18px 50px rgba(2, 6, 23, 0.45);
      text-align: center;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(1.6rem, 4vw, 2.3rem);
      line-height: 1.2;
    }
    p {
      margin: 0;
      color: #cbd5e1;
      font-size: clamp(1rem, 2.2vw, 1.15rem);
    }
    .row { margin-top: 18px; display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
    .chip {
      display: inline-block;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 0.85rem;
      letter-spacing: 0.02em;
      color: #06202a;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      font-weight: 700;
      text-decoration: none;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Chat Engine API Ready</h1>
    <p>Laravel can call this Node service for realtime chat with Ably.</p>
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
  <style>
    :root {
      --bg: #0b1020;
      --panel: #111a34;
      --panel-2: #0f1730;
      --text: #e8eefc;
      --muted: #91a0c0;
      --line: #22315f;
      --accent: #00d4ff;
      --accent-2: #00ffa3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(800px 500px at 15% -10%, rgba(0, 212, 255, 0.2), transparent 60%),
        radial-gradient(800px 500px at 95% 110%, rgba(0, 255, 163, 0.2), transparent 60%),
        var(--bg);
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .chat-wrap {
      width: min(860px, 96vw);
      background: linear-gradient(180deg, var(--panel), var(--panel-2));
      border: 1px solid var(--line);
      border-radius: 16px;
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
      overflow: hidden;
    }
    .topbar {
      padding: 14px 16px;
      border-bottom: 1px solid var(--line);
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .title { font-size: 1rem; font-weight: 700; }
    .status { font-size: 0.85rem; color: var(--muted); }
    #messages {
      height: 52vh;
      min-height: 320px;
      overflow: auto;
      padding: 16px;
      display: grid;
      gap: 10px;
    }
    .msg {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 12px;
      padding: 10px 12px;
    }
    .meta { font-size: 0.78rem; color: var(--muted); margin-bottom: 4px; }
    .text { font-size: 0.95rem; line-height: 1.35; white-space: pre-wrap; }
    .composer {
      border-top: 1px solid var(--line);
      padding: 12px;
      display: grid;
      gap: 10px;
    }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    input, button {
      border-radius: 10px;
      border: 1px solid var(--line);
      background: #0c1430;
      color: var(--text);
      padding: 10px 12px;
      font-size: 0.95rem;
    }
    button {
      cursor: pointer;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      color: #02222a;
      font-weight: 700;
      border: none;
    }
  </style>
</head>
<body>
  <main class="chat-wrap">
    <div class="topbar">
      <div class="title">Ably Realtime Chat Demo</div>
      <div id="status" class="status">Connecting...</div>
    </div>
    <section id="messages"></section>
    <form id="chatForm" class="composer">
      <div class="row">
        <input id="nameInput" maxlength="24" placeholder="Your name" required />
        <input value="global-chat" id="channelInput" maxlength="64" placeholder="Channel" required />
      </div>
      <input id="messageInput" maxlength="500" placeholder="Type a message" required />
      <button type="submit">Send Message</button>
    </form>
  </main>

  <script src="https://cdn.ably.com/lib/ably.min-1.js"></script>
  <script>
    const messagesEl = document.getElementById('messages');
    const statusEl = document.getElementById('status');
    const formEl = document.getElementById('chatForm');
    const nameInput = document.getElementById('nameInput');
    const channelInput = document.getElementById('channelInput');
    const messageInput = document.getElementById('messageInput');

    let channel;

    function addMessage(user, text, ts) {
      const item = document.createElement('article');
      item.className = 'msg';
      const when = new Date(ts || Date.now()).toLocaleTimeString();
      item.innerHTML = '<div class="meta">' + user + ' • ' + when + '</div><div class="text"></div>';
      item.querySelector('.text').textContent = text;
      messagesEl.appendChild(item);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function connect() {
      const clientId = 'demo-' + Math.random().toString(36).slice(2, 8);
      const realtime = new Ably.Realtime({ authUrl: '/api/ably-token?clientId=' + encodeURIComponent(clientId) });

      realtime.connection.on('connected', () => {
        statusEl.textContent = 'Connected';
      });

      realtime.connection.on('failed', (stateChange) => {
        statusEl.textContent = 'Connection failed: ' + stateChange.reason.message;
      });

      const channelName = channelInput.value.trim() || 'global-chat';
      channel = realtime.channels.get(channelName);

      channel.subscribe('message', (msg) => {
        const data = msg.data || {};
        addMessage(data.userName || data.user || 'Anonymous', data.text || '', data.ts || msg.timestamp);
      });
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!channel) return;

      const userName = nameInput.value.trim() || 'Anonymous';
      const text = messageInput.value.trim();
      if (!text) return;

      await channel.publish('message', {
        userName,
        text,
        ts: Date.now(),
        messageId: (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now())
      });

      messageInput.value = '';
      messageInput.focus();
    });

    connect();
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
    const tokenRequest = await createTokenRequest({
      clientId,
      channels: [DEFAULT_CHANNEL]
    });

    return res.json(tokenRequest);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to create demo token request.' });
  }
});

app.post('/api/chat/token', requireEngineKey, async (req, res) => {
  const { userId, userName, channels } = req.body || {};

  if (!userId || !userName) {
    return res.status(400).json({ error: 'userId and userName are required.' });
  }

  try {
    const tokenRequest = await createTokenRequest({
      clientId: `${userId}:${String(userName).trim()}`,
      channels
    });

    return res.json({ tokenRequest });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create token request.' });
  }
});

app.post('/api/chat/messages', requireEngineKey, async (req, res) => {
  const { channel, userId, userName, text, meta } = req.body || {};
  const channelName = String(channel || DEFAULT_CHANNEL).trim();

  if (!userId || !userName || !text) {
    return res.status(400).json({ error: 'userId, userName, and text are required.' });
  }

  const message = {
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
    pushMemoryMessage(channelName, message);
    return res.status(201).json({ ok: true, message });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to publish message.' });
  }
});

app.get('/api/chat/history', requireEngineKey, async (req, res) => {
  const channelName = String(req.query.channel || DEFAULT_CHANNEL).trim();
  const limit = clampLimit(req.query.limit, 30);

  try {
    const messages = await fetchHistory(channelName, limit);
    return res.json({ channel: channelName, messages, count: messages.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to fetch chat history.' });
  }
});

app.get('/api/chat/health', requireEngineKey, (req, res) => {
  res.json({
    status: 'ok',
    engine: 'node-ably',
    defaultChannel: DEFAULT_CHANNEL,
    hasAblyKey: Boolean(ABLY_API_KEY)
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
