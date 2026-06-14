const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// ─────────────────────────────────────────────
//  SECURITY: API keys live ONLY on the server
//  Set these in Railway → Variables:
//    ANTHROPIC_API_KEY    = sk-ant-...
//    GNEWS_API_KEY        = your gnews key   (optional)
//    RESEND_API_KEY       = re_...
//    SUPABASE_URL         = https://xxxx.supabase.co     (for daily digest)
//    SUPABASE_SERVICE_KEY = service_role key             (for daily digest)
//    DIGEST_SECRET        = any random string            (for daily digest)
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
  const query = req.query.q || 'project risk management';
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

// Ink-wash brand palette (matches the app/landing)
const BRAND = {
  ink: '#2B3440', slate: '#6D8196', slate2: '#566576', mist: '#88A0B4',
  cream: '#FFFFE3', creamLine: 'rgba(109,129,150,.18)', creamBg: '#f3f5f8',
  text: '#2B3440', sub: '#566576', muted: '#8DA0B1',
};

function emailShell(title, bodyHtml) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f7fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f7fa;padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(20,28,38,.08);">
<tr><td style="background:${BRAND.ink};padding:26px 32px;text-align:center;">
<span style="font-size:21px;font-weight:800;color:#F4F7FA;letter-spacing:1px;">RISK</span><span style="font-size:21px;font-weight:300;color:${BRAND.mist};letter-spacing:1px;">ATLAS</span>
<span style="display:inline-block;font-size:11px;font-weight:800;color:${BRAND.cream};border:2px solid ${BRAND.cream};border-radius:6px;padding:1px 7px;margin-left:8px;letter-spacing:2px;vertical-align:middle;">AI</span>
</td></tr>
<tr><td style="padding:36px 32px;color:${BRAND.text};">
<h1 style="margin:0 0 16px;font-size:20px;font-weight:800;letter-spacing:-.02em;color:${BRAND.text};">${title}</h1>
${bodyHtml}
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #eef1f5;color:${BRAND.muted};font-size:12px;line-height:1.6;text-align:center;">
RiskAtlas AI · Project Risk, Managed by AI<br>
<a href="https://riskatlas.pro" style="color:${BRAND.slate};text-decoration:none;">riskatlas.pro</a>
</td></tr>
</table>
<div style="max-width:480px;color:#b7c1cc;font-size:11px;margin-top:16px;text-align:center;line-height:1.5;">
You received this email because an account action was requested at riskatlas.pro.
</div>
</td></tr></table></body></html>`;
}

function codeBox(code) {
  return `<div style="background:${BRAND.creamBg};border:1px solid ${BRAND.creamLine};border-radius:12px;padding:22px;text-align:center;margin:0 0 20px;">
      <div style="font-size:34px;font-weight:800;letter-spacing:8px;color:${BRAND.slate2};font-family:'SF Mono',Menlo,monospace;">${code}</div>
    </div>`;
}

function tplVerify(code) {
  return emailShell('Confirm your email', `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${BRAND.sub};">Welcome to RiskAtlas AI. Use the code below to confirm your email and activate your account:</p>
    ${codeBox(code)}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">This code expires in 15 minutes. If you didn't create an account, you can safely ignore this email.</p>`);
}
function tplWelcome(name) {
  return emailShell(`Welcome aboard, ${name}!`, `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${BRAND.sub};">Your RiskAtlas AI account is active. You're ready to identify, analyze, and monitor project risks with AI.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 22px;"><tr><td style="border-radius:10px;background:${BRAND.cream};">
      <a href="https://riskatlas.pro/app" style="display:inline-block;padding:13px 26px;font-size:15px;font-weight:700;color:${BRAND.ink};text-decoration:none;">Open the Platform</a>
    </td></tr></table>
    <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">Need help getting started? Just reply to this email.</p>`);
}
function tplReset(code) {
  return emailShell('Reset your password', `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:${BRAND.sub};">We received a request to reset your password. Use the code below:</p>
    ${codeBox(code)}
    <p style="margin:0;font-size:13px;line-height:1.6;color:${BRAND.muted};">This code expires in 15 minutes. If you didn't request this, your password is still safe.</p>`);
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
    <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#566576;margin:0 0 16px;">
      <tr><td style="padding:4px 0;color:#8DA0B1;width:90px;">Name</td><td style="padding:4px 0;">${esc(name)}</td></tr>
      <tr><td style="padding:4px 0;color:#8DA0B1;">Email</td><td style="padding:4px 0;">${esc(email)}</td></tr>
      <tr><td style="padding:4px 0;color:#8DA0B1;">Company</td><td style="padding:4px 0;">${esc(company || '-')}</td></tr>
    </table>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#2B3440;white-space:pre-wrap;border-top:1px solid #eef1f5;padding-top:14px;">${esc(message)}</p>`);
  try {
    await sendEmail(CONTACT_TO, 'Contact form — ' + name, html, email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────
//  DAILY DIGEST — "Today's Tasks" morning email
//  Schedule a daily GET to:
//    https://riskatlas.pro/api/digest/run?key=DIGEST_SECRET
//  (Railway cron or cron-job.org · 05:00 UTC ≈ 8am KSA)
// ─────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const DIGEST_SECRET = process.env.DIGEST_SECRET || '';

async function sbAdmin(qpath) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${qpath}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`sbAdmin ${qpath}: ${r.status}`);
  return r.json();
}

function digestForUser(projects) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = 86400000;
  const due = [], overdue = [];
  let soon = 0;
  for (const p of projects) {
    const acts = (p.action_plan && p.action_plan.actions) || [];
    for (const a of acts) {
      if (a.status === 'done' || a.last_touched === today.toISOString().slice(0, 10)) continue;
      if (!a.due_date || isNaN(new Date(a.due_date))) continue;
      const d = Math.round((new Date(a.due_date).setHours(0, 0, 0, 0) - today.getTime()) / day);
      const item = { title: a.title, proj: p.name, risk: a.risk_id };
      if (d < 0) overdue.push(item);
      else if (d === 0) due.push(item);
      else if (d <= 7) soon++;
    }
  }
  return { due, overdue, soon };
}

function digestHtml(name, d) {
  const row = (i, color, tag) => `
    <tr><td style="padding:10px 0;border-bottom:1px solid #eef1f5;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="14" valign="top" style="padding-top:5px;"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};"></span></td>
        <td style="font:600 14px/1.4 -apple-system,Helvetica,Arial;color:#2B3440;">${i.title}
          <div style="font:400 12px/1.5 -apple-system,Helvetica,Arial;color:#8DA0B1;margin-top:2px;">${i.proj} · ${i.risk} · ${tag}</div>
        </td>
      </tr></table>
    </td></tr>`;
  const items = d.overdue.map(i => row(i, '#f64e60', 'overdue')).join('') +
                d.due.map(i => row(i, '#ffa800', 'due today')).join('');
  const total = d.due.length + d.overdue.length;
  const intro = total
    ? `You have <b>${total} action${total > 1 ? 's' : ''}</b> to tackle today${d.overdue.length ? ` (<b style="color:#f64e60">${d.overdue.length} overdue</b>)` : ''}. Start with the red items — they cut your exposure fastest.`
    : `Nothing urgent today — ${d.soon} action${d.soon === 1 ? '' : 's'} coming up this week. A light day.`;
  return emailShell(`Good morning, ${name}`, `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#566576;">${intro}</p>
    ${items ? `<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;">${items}</table>` : ''}
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:24px;background:#FFFFE3;">
      <a href="https://riskatlas.pro/app" style="display:inline-block;padding:12px 26px;font:700 14px -apple-system,Helvetica,Arial;color:#2B3440;text-decoration:none;">Open Today's Tasks →</a>
    </td></tr></table>`);
}

app.get('/api/digest/run', async (req, res) => {
  try {
    if (!DIGEST_SECRET || req.query.key !== DIGEST_SECRET) return res.status(403).json({ error: 'forbidden' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(503).json({ error: 'digest not configured' });
    if (!RESEND_API_KEY) return res.status(503).json({ error: 'email not configured' });

    const users = await sbAdmin('users?select=id,email,full_name');
    const projects = await sbAdmin('projects?select=id,name,user_id,action_plan');
    const byUser = {};
    for (const p of projects) (byUser[p.user_id] = byUser[p.user_id] || []).push(p);

    let sent = 0, skipped = 0;
    for (const u of users) {
      const ps = byUser[u.id] || [];
      if (!ps.length) { skipped++; continue; }
      const d = digestForUser(ps);
      if (!d.due.length && !d.overdue.length && !d.soon) { skipped++; continue; }
      const name = (u.full_name || '').split(' ')[0] || 'there';
      const subject = (d.due.length + d.overdue.length)
        ? `Your risk briefing — ${d.due.length + d.overdue.length} action${(d.due.length + d.overdue.length) > 1 ? 's' : ''} today`
        : 'Your risk briefing — a light day ahead';
      try { await sendEmail(u.email, subject, digestHtml(name, d)); sent++; }
      catch (e) { console.error('digest send failed for', u.email, e.message); }
      await new Promise(r => setTimeout(r, 600)); // gentle with Resend limits
    }
    res.json({ ok: true, sent, skipped, users: users.length });
  } catch (e) {
    console.error('digest error', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  PURGE deactivated accounts after 30-day grace period
//  Schedule a daily GET (reuses DIGEST_SECRET):
//    https://riskatlas.pro/api/accounts/purge?key=DIGEST_SECRET
// ═══════════════════════════════════════════════════════════════════════
app.get('/api/accounts/purge', async (req, res) => {
  try {
    if (!DIGEST_SECRET || req.query.key !== DIGEST_SECRET) return res.status(403).json({ error: 'forbidden' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(503).json({ error: 'not configured' });

    const cutoff = new Date(Date.now() - 30 * 86400000).toISOString();
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/users?status=eq.deactivated&deactivated_at=lt.${cutoff}&select=id,email`,
      { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } }
    );
    const stale = await r.json();
    if (!Array.isArray(stale) || !stale.length) return res.json({ ok: true, purged: 0 });

    const del = (tbl, q) => fetch(`${SUPABASE_URL}/rest/v1/${tbl}?${q}`, {
      method: 'DELETE',
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, Prefer: 'return=minimal' },
    });

    let purged = 0;
    for (const u of stale) {
      try {
        const pr = await fetch(`${SUPABASE_URL}/rest/v1/projects?user_id=eq.${u.id}&select=id`,
          { headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` } });
        const projects = await pr.json();
        const ids = Array.isArray(projects) ? projects.map(p => p.id) : [];
        if (ids.length) {
          const inList = `(${ids.join(',')})`;
          await del('risk_events', `project_id=in.${inList}`);
          await del('risks', `project_id=in.${inList}`);
          await del('project_members', `project_id=in.${inList}`);
        }
      } catch (e) { /* continue */ }

      await del('projects', `user_id=eq.${u.id}`);
      await del('portfolios', `user_id=eq.${u.id}`);
      await del('project_members', `user_email=eq.${encodeURIComponent(u.email)}`);
      await del('users', `id=eq.${u.id}`);

      try {
        await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${u.id}`, {
          method: 'DELETE',
          headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
        });
      } catch (e) { /* continue */ }

      purged++;
      await new Promise(r => setTimeout(r, 300));
    }
    res.json({ ok: true, purged });
  } catch (e) {
    console.error('purge error', e);
    res.status(500).json({ error: e.message });
  }
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
