const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
// Stripe webhook needs the RAW body for signature verification — exclude it from JSON parsing.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe/webhook') return next();
  express.json({ limit: '50mb' })(req, res, next);
});
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
  // ── Always stream the upstream request to Anthropic, then reassemble it into the
  //    SAME non-streaming JSON shape the frontend already expects (no frontend changes).
  //    WHY: a single long-held non-streaming connection (large max_tokens — e.g. 20000
  //    for register generation — can take 60-120+ seconds) is prone to being killed by
  //    intermediary proxies/load balancers mid-flight, surfacing as
  //    "Invalid response body ... Premature close". Streaming keeps the connection
  //    active with a steady trickle of small chunks, which is Anthropic's own
  //    recommended pattern for large-output requests and avoids this failure mode.
  const upstreamBody = { ...req.body, stream: true };
  const MAX_ATTEMPTS = 2;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(upstreamBody),
      });

      if (!response.ok) {
        // Non-streaming error response (e.g. 4xx/5xx) — pass it straight through.
        const errData = await response.json().catch(() => ({ error: { message: 'Upstream error ' + response.status } }));
        return res.status(response.status).json(errData);
      }

      // ── Parse the SSE stream and reassemble a standard Messages API response ──
      const contentBlocks = [];   // { type, text? , ...tool_use fields }
      let stopReason = null, stopSequence = null, usage = null, modelName = req.body.model || null, msgId = null;
      let buf = '';
      for await (const chunk of response.body) {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const rawEvent = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
          if (!dataLine) continue;
          const jsonStr = dataLine.slice(5).trim();
          if (!jsonStr || jsonStr === '[DONE]') continue;
          let evt;
          try { evt = JSON.parse(jsonStr); } catch { continue; }
          switch (evt.type) {
            case 'message_start':
              msgId = evt.message?.id || msgId;
              modelName = evt.message?.model || modelName;
              usage = evt.message?.usage || usage;
              break;
            case 'content_block_start':
              contentBlocks[evt.index] = evt.content_block?.type === 'tool_use'
                ? { type: 'tool_use', id: evt.content_block.id, name: evt.content_block.name, input: {} , _partialJson: '' }
                : { type: 'text', text: '' };
              break;
            case 'content_block_delta':
              if (!contentBlocks[evt.index]) contentBlocks[evt.index] = { type: 'text', text: '' };
              if (evt.delta?.type === 'text_delta') contentBlocks[evt.index].text += evt.delta.text;
              else if (evt.delta?.type === 'input_json_delta') contentBlocks[evt.index]._partialJson += evt.delta.partial_json || '';
              break;
            case 'content_block_stop':
              if (contentBlocks[evt.index] && contentBlocks[evt.index].type === 'tool_use') {
                try { contentBlocks[evt.index].input = JSON.parse(contentBlocks[evt.index]._partialJson || '{}'); } catch { contentBlocks[evt.index].input = {}; }
                delete contentBlocks[evt.index]._partialJson;
              }
              break;
            case 'message_delta':
              stopReason = evt.delta?.stop_reason ?? stopReason;
              stopSequence = evt.delta?.stop_sequence ?? stopSequence;
              if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
              break;
            case 'error':
              throw new Error(evt.error?.message || 'Upstream stream error');
            default:
              break; // message_stop, ping — nothing to accumulate
          }
        }
      }

      return res.status(200).json({
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: modelName,
        content: contentBlocks.filter(Boolean),
        stop_reason: stopReason,
        stop_sequence: stopSequence,
        usage,
      });
    } catch (error) {
      lastErr = error;
      // Transient network/stream errors (e.g. "Premature close") — retry once before giving up.
      if (attempt < MAX_ATTEMPTS) continue;
    }
  }
  res.status(500).json({ error: { message: lastErr ? lastErr.message : 'Unknown error contacting AI service' } });
});

// ── Pass-through streaming endpoint ──────────────────────────────────────
// For LARGE requests (e.g. register generation, max_tokens 20000 on Opus, which
// can take 2-3 minutes) a buffered response — even one that streams internally
// then returns JSON at the end — still holds the client connection open with no
// bytes sent for minutes, so Railway's edge proxy kills it → "Premature close".
// This endpoint instead pipes Anthropic's SSE stream straight to the browser as
// it arrives: the first bytes reach the client within seconds, the connection is
// continuously active, and Railway never times it out. The browser reassembles
// the message (see api() in the frontend). Non-large calls can use this too.
app.post('/api/claude/stream', claudeLimiter, async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: { message: 'AI service not configured. Administrator must set ANTHROPIC_API_KEY.' } });
  }
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ ...req.body, stream: true }),
    });
    if (!upstream.ok) {
      const errData = await upstream.json().catch(() => ({ error: { message: 'Upstream error ' + upstream.status } }));
      return res.status(upstream.status).json(errData);
    }
    // Stream SSE straight through to the client.
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering where honoured
    if (res.flushHeaders) res.flushHeaders();
    for await (const chunk of upstream.body) {
      res.write(chunk);
      if (res.flush) res.flush();
    }
    res.end();
  } catch (error) {
    // If we haven't sent headers yet, return JSON; otherwise close the stream.
    if (!res.headersSent) res.status(500).json({ error: { message: error.message } });
    else { try { res.end(); } catch (e) {} }
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

// ── Password reset via Resend (same provider as email verification) ──
// The reset code is generated and held SERVER-SIDE (short-lived, in-memory) so the
// browser can't forge a "verified" state. Flow:
//   1) POST /api/email/reset  { to }            → server makes a 6-digit code, stores
//      it keyed by email with a 15-min expiry, emails it via Resend (tplReset).
//   2) POST /api/auth/reset-confirm { to, code, password }
//      → server checks the code, and if valid updates the password through the
//        Supabase Admin API (service key), then clears the code.
// This keeps the whole flow on the platform's own branded email (noreply@riskatlas.pro),
// never Supabase's default auth email.
const _resetCodes = new Map(); // email -> { code, expires, attempts }
function _genCode() { return String(Math.floor(100000 + Math.random() * 900000)); }
// periodic cleanup of expired codes
setInterval(() => { const now = Date.now(); for (const [k, v] of _resetCodes) if (v.expires < now) _resetCodes.delete(k); }, 5 * 60 * 1000).unref?.();

app.post('/api/email/reset', emailLimiter, async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim().toLowerCase();
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Valid email required' });
  try {
    const code = _genCode();
    _resetCodes.set(to, { code, expires: Date.now() + 15 * 60 * 1000, attempts: 0 });
    await sendEmail(to, 'Reset your RiskAtlas AI password', tplReset(code));
    // Always report success shape (don't leak whether the address exists).
    res.json({ sent: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/reset-confirm', emailLimiter, async (req, res) => {
  const to = String((req.body && req.body.to) || '').trim().toLowerCase();
  const code = String((req.body && req.body.code) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!to || !code || !password) return res.status(400).json({ error: 'Missing fields' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return res.status(503).json({ error: 'Password reset not configured' });

  const rec = _resetCodes.get(to);
  if (!rec) return res.status(400).json({ error: 'No reset request found. Please request a new code.' });
  if (Date.now() > rec.expires) { _resetCodes.delete(to); return res.status(400).json({ error: 'Code expired. Please request a new one.' }); }
  rec.attempts = (rec.attempts || 0) + 1;
  if (rec.attempts > 6) { _resetCodes.delete(to); return res.status(429).json({ error: 'Too many attempts. Please request a new code.' }); }
  if (rec.code !== code) return res.status(400).json({ error: 'Incorrect code. Please check and try again.' });

  try {
    // Find the user by email via the Admin API, then update their password.
    const lookup = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(to)}`, {
      headers: { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
    });
    const lj = await lookup.json().catch(() => ({}));
    const user = (lj.users && lj.users[0]) || (Array.isArray(lj) && lj[0]) || null;
    if (!user || !user.id) { _resetCodes.delete(to); return res.status(400).json({ error: 'Account not found for this email.' }); }

    const upd = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
      body: JSON.stringify({ password }),
    });
    if (!upd.ok) { const ej = await upd.json().catch(() => ({})); return res.status(500).json({ error: ej.msg || ej.error_description || 'Could not update password' }); }
    _resetCodes.delete(to); // one-time use
    res.json({ updated: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Share assigned tasks with a team member (one consolidated email) ───
function tplTasks(ownerName, projectName, senderName, tasks) {
  const row = (t) => {
    const color = t.overdue ? '#f64e60' : (t.dueToday ? '#ffa800' : BRAND.slate);
    const tag = t.overdue ? 'overdue' : (t.dueToday ? 'due today' : (t.due ? 'due ' + t.due : ''));
    return `<tr><td style="padding:12px 0;border-bottom:1px solid #eef1f5;">
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
        <td width="16" valign="top" style="padding-top:5px;"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${color};"></span></td>
        <td style="font:600 14px/1.45 -apple-system,Helvetica,Arial;color:${BRAND.text};">${t.title}
          <div style="font:400 12px/1.5 -apple-system,Helvetica,Arial;color:${BRAND.muted};margin-top:3px;">
            ${[t.risk_id, t.risk_desc, tag].filter(Boolean).join(' · ')}
          </div>
        </td>
      </tr></table>
    </td></tr>`;
  };
  const n = tasks.length;
  return emailShell(`Hi ${ownerName || 'there'}`, `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.6;color:${BRAND.sub};">
      ${senderName ? senderName + ' has' : 'You have been'} assigned <b>${n} task${n > 1 ? 's' : ''}</b>${projectName ? ` on <b>${projectName}</b>` : ''}. Here's your consolidated list:
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 22px;">${tasks.map(row).join('')}</table>
    <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:${BRAND.cream};">
      <a href="https://riskatlas.pro/app" style="display:inline-block;padding:13px 26px;font:700 14px -apple-system,Helvetica,Arial;color:${BRAND.ink};text-decoration:none;">Open RiskAtlas AI →</a>
    </td></tr></table>
    <p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:${BRAND.muted};">Please action these and update the register when done.</p>`);
}

app.post('/api/email/tasks', emailLimiter, async (req, res) => {
  const { to, ownerName, projectName, senderName, tasks } = req.body || {};
  if (!to || !Array.isArray(tasks) || !tasks.length) return res.status(400).json({ error: 'Missing recipient or tasks' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Invalid email' });
  // cap to avoid abuse
  const safeTasks = tasks.slice(0, 30).map(t => ({
    title: String(t.title || '').slice(0, 200),
    risk_id: String(t.risk_id || '').slice(0, 20),
    risk_desc: String(t.risk_desc || '').slice(0, 400),
    due: String(t.due || '').slice(0, 40),
    overdue: !!t.overdue, dueToday: !!t.dueToday,
  }));
  try {
    const subj = `Your assigned tasks${projectName ? ' — ' + String(projectName).slice(0, 60) : ''} (${safeTasks.length})`;
    await sendEmail(to, subj, tplTasks(String(ownerName || '').slice(0, 80), String(projectName || '').slice(0, 80), String(senderName || '').slice(0, 80), safeTasks));
    res.json({ sent: true, count: safeTasks.length });
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

// ═══════════════════════════════════════════════════════════════════════
//  STRIPE — subscriptions & billing
//  Required env vars (set in Railway when the bank account is approved):
//    STRIPE_SECRET_KEY        = sk_live_... (or sk_test_... while testing)
//    STRIPE_WEBHOOK_SECRET    = whsec_...   (from the Stripe webhook settings)
//    STRIPE_PRICE_STARTER     = price_...   (the $49/mo price ID)
//    STRIPE_PRICE_PROFESSIONAL= price_...   (the $149/mo price ID)
//    STRIPE_PRICE_ENTERPRISE  = price_...   (the $399/mo price ID)
//    APP_URL                  = https://riskatlas.pro  (for redirect URLs)
//  The system stays fully dormant until STRIPE_SECRET_KEY is present.
// ═══════════════════════════════════════════════════════════════════════
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const APP_URL = process.env.APP_URL || 'https://riskatlas.pro';
let stripe = null;
if (STRIPE_SECRET_KEY) {
  try { stripe = require('stripe')(STRIPE_SECRET_KEY); }
  catch (e) { console.error('Stripe init failed — run: npm install stripe', e.message); }
}

// Map our internal plan keys → Stripe price IDs (and back)
const PLAN_TO_PRICE = {
  starter: process.env.STRIPE_PRICE_STARTER || '',
  professional: process.env.STRIPE_PRICE_PROFESSIONAL || '',
  enterprise: process.env.STRIPE_PRICE_ENTERPRISE || ''
};
const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_TO_PRICE).filter(([, v]) => v).map(([k, v]) => [v, k])
);

// Patch the user's plan in Supabase (service-role) by Stripe customer id or email
async function setUserPlan({ customerId, email, userId, plan, subscriptionId, status }) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('[stripe] Supabase not configured for plan update'); return; }
  const patch = {};
  if (plan) patch.plan = plan;
  if (subscriptionId !== undefined) patch.stripe_subscription_id = subscriptionId;
  if (customerId) patch.stripe_customer_id = customerId;
  if (status) patch.subscription_status = status;
  if (plan) patch.plan_start = new Date().toISOString();
  const hdr = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' };
  const patchBy = async (filter) => {
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/users?${filter}`, { method: 'PATCH', headers: hdr, body: JSON.stringify(patch) });
      const txt = await r.text();
      let rows = [];
      try { rows = JSON.parse(txt); } catch (e) {}
      if (!r.ok) { console.error(`[stripe] setUserPlan PATCH ${filter} failed:`, txt); return 0; }
      console.log(`[stripe] setUserPlan PATCH ${filter} → ${Array.isArray(rows) ? rows.length : 0} row(s) updated to plan=${plan || '(unchanged)'} status=${status || ''}`);
      return Array.isArray(rows) ? rows.length : 0;
    } catch (e) { console.error('[stripe] setUserPlan error', e.message); return 0; }
  };
  let updated = 0;
  // 1) most reliable: match by the platform user id (passed as client_reference_id)
  if (userId) updated = await patchBy(`id=eq.${encodeURIComponent(userId)}`);
  // 2) by stripe_customer_id (returning subscribers)
  if (!updated && customerId) updated = await patchBy(`stripe_customer_id=eq.${encodeURIComponent(customerId)}`);
  // 3) fall back to email (first purchase — no customer id stored yet)
  if (!updated && email) updated = await patchBy(`email=eq.${encodeURIComponent(email)}`);
  if (!updated) console.error(`[stripe] setUserPlan: NO ROW MATCHED (userId=${userId || '-'}, customerId=${customerId || '-'}, email=${email || '-'}). Check the email matches the signup email exactly.`);
  return updated;
}

// 1) Create a Checkout Session — frontend calls this when the user picks a plan
app.post('/api/stripe/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not enabled yet.' });
  try {
    const { plan, email, userId } = req.body || {};
    const priceId = PLAN_TO_PRICE[plan];
    if (!priceId) return res.status(400).json({ error: 'Unknown or unconfigured plan.' });
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email || undefined,
      client_reference_id: userId || undefined,
      metadata: { plan, userId: userId || '', email: email || '' },
      subscription_data: { metadata: { plan, userId: userId || '', email: email || '' } },
      success_url: `${APP_URL}/app?billing=success`,
      cancel_url: `${APP_URL}/app?billing=cancelled`,
      allow_promotion_codes: true
    });
    res.json({ url: session.url });
  } catch (e) { console.error('checkout error', e.message); res.status(500).json({ error: e.message }); }
});

// 2) Billing portal — lets a subscriber manage / cancel their plan
app.post('/api/stripe/portal', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing is not enabled yet.' });
  try {
    const { customerId } = req.body || {};
    if (!customerId) return res.status(400).json({ error: 'Missing customer id.' });
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: `${APP_URL}/app`
    });
    res.json({ url: session.url });
  } catch (e) { console.error('portal error', e.message); res.status(500).json({ error: e.message }); }
});

// 3) Webhook — Stripe calls this; we update the user's plan in Supabase.
//    NOTE: must receive the RAW body for signature verification (configured below).
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('webhook signature verification failed', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        const plan = (s.metadata && s.metadata.plan) || PRICE_TO_PLAN[s.line_items?.[0]?.price] || 'starter';
        const email = s.customer_email || s.customer_details?.email || (s.metadata && s.metadata.email);
        const userId = s.client_reference_id || (s.metadata && s.metadata.userId);
        console.log(`[stripe] checkout.session.completed: plan=${plan} customer=${s.customer} email=${email || '-'} userId=${userId || '-'}`);
        await setUserPlan({ customerId: s.customer, email, userId, plan, subscriptionId: s.subscription, status: 'active' });
        break;
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const priceId = sub.items?.data?.[0]?.price?.id;
        const plan = PRICE_TO_PLAN[priceId] || (sub.metadata && sub.metadata.plan);
        const status = sub.status; // active, past_due, canceled, etc.
        await setUserPlan({ customerId: sub.customer, plan: status === 'active' ? plan : undefined, subscriptionId: sub.id, status });
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        // subscription ended → drop them back to free_trial (expired) / no access
        await setUserPlan({ customerId: sub.customer, plan: 'free_trial', subscriptionId: null, status: 'canceled' });
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        await setUserPlan({ customerId: inv.customer, status: 'past_due' });
        break;
      }
      default: break;
    }
    res.json({ received: true });
  } catch (e) { console.error('webhook handler error', e.message); res.status(500).end(); }
});

// Status probe for the frontend (so it knows whether billing is live)
app.get('/api/stripe/status', (req, res) => {
  res.json({ enabled: !!stripe, plans: Object.keys(PLAN_TO_PRICE).filter(k => PLAN_TO_PRICE[k]) });
});

// ─────────────────────────────────────────────
//  Routing: landing at /, platform at /app
// ─────────────────────────────────────────────
// SEO: sitemap + robots (must come before the catch-all)
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml');
  res.sendFile(path.join(__dirname, 'public', 'sitemap.xml'));
});
app.get('/robots.txt', (req, res) => {
  res.type('text/plain');
  res.sendFile(path.join(__dirname, 'public', 'robots.txt'));
});
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
