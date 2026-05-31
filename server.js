const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

app.post('/api/claude', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || !apiKey.startsWith('sk-ant-')) {
    return res.status(401).json({ error: { message: 'Invalid API key' } });
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: { message: error.message } });
  }
});

app.get('/api/news', async (req, res) => {
  const newsKey = req.headers['x-news-key'];
  const query = req.query.q || 'construction';
  const lang = req.query.lang || 'en';
  const country = req.query.country || 'sa';
  
  if (!newsKey) {
    return res.status(401).json({ error: 'Missing news API key' });
  }
  
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=${lang}&country=${country}&max=10&apikey=${newsKey}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve the platform app at /app (and /app/*)
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve landing page at root, platform for /app paths
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
