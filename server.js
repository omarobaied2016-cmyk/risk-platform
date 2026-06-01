const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─────────────────────────────────────────────
//  SECURITY: API keys live ONLY on the server
//  Set these in Railway → Variables:
//    ANTHROPIC_API_KEY = sk-ant-...
//    GNEWS_API_KEY     = your gnews key   (optional)
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GNEWS_API_KEY = process.env.GNEWS_API_KEY || '';

// ─────────────────────────────────────────────
//  RATE LIMITING (simple in-memory, per-IP)
// ─────────────────────────────────────────────
const rateBuckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const id = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
      .toString().split(',')[0].trim();
    const bucketKey = key + ':' + id;
    const now = Date.now();
    let b = rateBuckets.get(bucketKey);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      rateBuckets.set(bucketKey, b);
    }
    b.count++;
    if (b.count > max) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({
        error: { message: `Rate limit exceeded. Try again in ${retry}s.` }
      });
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k);
}, 10 * 60 * 1000);

const claudeLimiter = rateLimit({ windowMs: 60 * 1000, max: 40, key: 'claude' });
const newsLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, key: 'news' });

// ─────────────────────────────────────────────
//  Claude proxy — key from server env only
// ─────────────────────────────────────────────
app.post('/api/claude', claudeLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: { message: 'AI service not configured. Administrator must set ANTHROPIC_API_KEY.' } });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

app.get('/api/claude/status', (req, res) => {
  res.json({ configured: !!ANTHROPIC_API_KEY });
});

// ─────────────────────────────────────────────
//  GNews proxy
// ─────────────────────────────────────────────
app.get('/api/news', newsLimiter, async (req, res) => {
  const newsKey = GNEWS_API_KEY || req.headers['x-news-key'];
  const query = req.query.q || 'construction';
  const lang = req.query.lang || 'en';
  const country = req.query.country || 'us';
  if (!newsKey) {
    return res.status(503).json({ error: 'News service not configured.' });
  }
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=${lang}&country=${country}&max=10&apikey=${newsKey}`;
    const response = await fetch(url);
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/news/status', (req, res) => {
  res.json({ configured: !!GNEWS_API_KEY });
});

// ─────────────────────────────────────────────
//  Routing: landing at /, platform at /app
// ─────────────────────────────────────────────
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('*', (req, res) => {
  if (req.path.startsWith('/app')) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Risk Platform running on port ${PORT}`);
});
