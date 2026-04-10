const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
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
      width: min(700px, 92vw);
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
    .chip {
      display: inline-block;
      margin-top: 18px;
      padding: 8px 12px;
      border-radius: 999px;
      font-size: 0.85rem;
      letter-spacing: 0.02em;
      color: #06202a;
      background: linear-gradient(90deg, var(--accent), var(--accent-2));
      font-weight: 700;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Hostinger Auto Deploy Is Live</h1>
    <p>This page was updated from GitHub webhook deployment.</p>
    <span class="chip">Node.js + Express ✅</span>
  </main>
</body>
</html>`);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
