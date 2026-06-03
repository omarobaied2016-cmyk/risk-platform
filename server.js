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
//  EMAIL via Resend
//  Set in Railway → Variables:
//    RESEND_API_KEY = re_...
//    EMAIL_FROM     = RiskAtlas AI <noreply@riskatlas.pro>  (optional)
//    CONTACT_TO     = your-inbox@riskatlas.pro              (optional)
// ─────────────────────────────────────────────
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'RiskAtlas AI <noreply@riskatlas.pro>';
const CONTACT_TO = process.env.CONTACT_TO || 'support@riskatlas.pro';
const emailLimiter = rateLimit({ windowMs: 60 * 1000, max: 10, key: 'email' });

function emailShell(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(20,20,50,.06);">
<tr><td style="background:linear-gradient(135deg,#7239ea,#8950fc);padding:28px 32px;text-align:center;">
<div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-.02em;">RiskAtlas <span style="opacity:.85;">AI</span></div>
</td></tr>
<tr><td style="padding:36px 32px;color:#15152b;">
<h1 style="margin:0 0 16px;font-size:20px;font-weight:800;letter-spacing:-.02em;color:#15152b;">${title}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #eef0f7;color:#8888a8;font-size:12px;line-height:1.6;text-align:center;">
RiskAtlas AI · AI-Powered Risk Management<br>
<a href="https://riskatlas.pro" style="color:#7239ea;text-decoration:none;">riskatlas.pro</a>
</td></tr>
</table>
<div style="max-width:480px;color:#b5b7c8;font-size:11px;margin-top:16px;text-align:center;line-height:1.5;">
You received this email because an account action was requested at riskatlas.pro.
</div>
</td></tr></table></body></html>`;
}

function tplVerify(code) {
  return emailShell('Confirm your email', `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4a4a68;">Welcome to RiskAtlas AI. Use the code below to confirm your email and activate your account:</p>
    <div style="background:#f3efff;border:1px solid rgba(114,57,234,.18);border-radius:12px;padding:22px;text-align:center;margin:0 0 20px;">
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#7239ea;font-family:'SF Mono',Menlo,monospace;">${code}</div>
    </div>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#8888a8;">This code expires in 15 minutes. If you didn't create an account, you can safely ignore this email.</p>`);
}
function tplWelcome(name) {
  return emailShell(`Welcome aboard, ${name}!`, `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#4a4a68;">Your RiskAtlas AI account is active. You're ready to identify, analyze, and monitor project risks with AI.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr><td style="border-radius:10px;background:#7239ea;">
      <a href="https://riskatlas.pro/app" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Open the Platform</a>
    </td></tr></table>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#8888a8;">Need help getting started? Just reply to this email.</p>`);
}
function tplReset(code) {
  return emailShell('Reset your password', `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4a4a68;">We received a request to reset your password. Use the code below:</p>
    <div style="background:#f3efff;border:1px solid rgba(114,57,234,.18);border-radius:12px;padding:22px;text-align:center;margin:0 0 20px;">
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:#7239ea;font-family:'SF Mono',Menlo,monospace;">${code}</div>
    </div>
    <p style="margin:0;font-size:13px;line-height:1.6;color:#8888a8;">This code expires in 15 minutes. If you didn't request this, your password is still safe.</p>`);
}

async function sendEmail(to, subject, html, replyTo) {
  if (!RESEND_API_KEY) throw new Error('Email service not configured');
  const payload = { from: EMAIL_FROM, to: [to], subject, html };
  if (replyTo) payload.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_API_KEY },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.message || 'Email send failed');
  return data;
}

app.post('/api/email/verify', emailLimiter, async (req, res) => {
  const { to, code } = req.body || {};
  if (!to || !code) return res.status(400).json({ error: 'Missing fields' });
  try {
    await sendEmail(to, 'Confirm your RiskAtlas AI email', tplVerify(code));
    res.json({ sent: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/email/welcome', emailLimiter, async (req, res) => {
  const { to, name } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Missing recipient' });
  try {
    await sendEmail(to, 'Welcome to RiskAtlas AI', tplWelcome(name || 'there'));
    res.json({ sent: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/email/reset', emailLimiter, async (req, res) => {
  const { to, code } = req.body || {};
  if (!to || !code) return res.status(400).json({ error: 'Missing fields' });
  try {
    await sendEmail(to, 'Reset your RiskAtlas AI password', tplReset(code));
    res.json({ sent: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/email/status', (req, res) => {
  res.json({ configured: !!RESEND_API_KEY });
});

// ─────────────────────────────────────────────
//  CONTACT form → email via Resend
// ─────────────────────────────────────────────
app.post('/api/contact', emailLimiter, async (req, res) => {
  const { name, email, company, message } = req.body || {};
  if (!name || !email || !message) return res.status(400).json({ ok: false, error: 'Missing required fields.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) return res.status(400).json({ ok: false, error: 'Invalid email.' });
  if (String(message).length > 5000) return res.status(400).json({ ok: false, error: 'Message too long.' });
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const html = emailShell('New contact message', `
    <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#4a4a68;margin:0 0 16px;">
      <tr><td style="padding:4px 0;color:#8888a8;width:90px;">Name</td><td style="padding:4px 0;">${esc(name)}</td></tr>
      <tr><td style="padding:4px 0;color:#8888a8;">Email</td><td style="padding:4px 0;">${esc(email)}</td></tr>
      <tr><td style="padding:4px 0;color:#8888a8;">Company</td><td style="padding:4px 0;">${esc(company || '-')}</td></tr>
    </table>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#15152b;white-space:pre-wrap;border-top:1px solid #eef0f7;padding-top:14px;">${esc(message)}</p>`);
  try {
    await sendEmail(CONTACT_TO, 'Contact form — ' + name, html, email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────
//  Legal pages (clean URLs) — must be BEFORE catch-all
// ─────────────────────────────────────────────
['privacy', 'terms', 'cookies', 'contact'].forEach((page) => {
  app.get('/' + page, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', page + '.html'));
  });
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
