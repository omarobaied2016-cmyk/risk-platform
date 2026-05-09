const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));

app.use(express.static(path.join(__dirname, 'public')));

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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Risk Platform running on port ${PORT}`);
});
