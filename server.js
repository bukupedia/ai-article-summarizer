const http = require('http');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const PORT = process.env.PORT || 12000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Allowed values (whitelist for validation)
const ALLOWED_AUDIENCES = {
  'busy-professionals': 'Busy professionals',
  'executives': 'Executives',
  'students': 'Students',
  'general': 'General audience'
};

const ALLOWED_LENGTHS = ['100', '150', '250'];

const ALLOWED_FOCUS = {
  'main-ideas': 'Main ideas',
  'key-insights': 'Key insights',
  'arguments': 'Arguments & conclusions',
  'actionable': 'Actionable takeaways'
};

// Rate limiting storage (in production, use Redis or similar)
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10;

// ============================================================================
// SECURITY HELPERS
// ============================================================================

function sanitizeString(str, maxLength = 50000) {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLength).trim();
}

function getClientIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
         req.socket?.remoteAddress ||
         'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const clientData = rateLimitMap.get(ip) || { count: 0, windowStart: now };

  // Reset window if expired
  if (now - clientData.windowStart > RATE_LIMIT_WINDOW_MS) {
    clientData.count = 0;
    clientData.windowStart = now;
  }

  clientData.count++;
  rateLimitMap.set(ip, clientData);

  return clientData.count <= RATE_LIMIT_MAX_REQUESTS;
}

// Clean up old rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of rateLimitMap.entries()) {
    if (now - data.windowStart > RATE_LIMIT_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 60000);

// ============================================================================
// SECURITY HEADERS
// ============================================================================

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', 
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline'; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "img-src 'self' data:; " +
    "font-src 'self' https://cdn.jsdelivr.net; " +
    "connect-src 'self'; " +
    "frame-ancestors 'none';"
  );
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

// ============================================================================
// PROMPT BUILDING (Server-side only)
// ============================================================================

function buildPrompt(article, audience, length, focus) {
  // Use mapped display values to prevent prompt injection via select values
  const audienceText = ALLOWED_AUDIENCES[audience] || 'General audience';
  const focusText = ALLOWED_FOCUS[focus] || 'Main ideas';
  const lengthNum = ALLOWED_LENGTHS.includes(length) ? length : '150';

  return `Act as a professional editor skilled at turning long content into clear, useful summaries.

Audience: ${audienceText}

Your task: Summarize the article below.

Constraints:
- Length: Under ${lengthNum} words
- Focus: ${focusText}
- Exclude: filler, repetition, weak examples
- Language: simple and clear

Output format:
1. Overview (1 sentence)
2. Key Points (bullet list)
3. Actionable Insights (bullet list)

Article:
---
${article}
---`;
}

// ============================================================================
// API HANDLERS
// ============================================================================

async function handleSummarize(req, res) {
  // Check API key configuration
  if (!OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY environment variable not set');
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Service not configured' }));
    return;
  }

  // Rate limiting
  const clientIP = getClientIP(req);
  if (!checkRateLimit(clientIP)) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limit exceeded. Please try again later.' }));
    return;
  }

  // Parse request body
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    // Prevent oversized requests
    if (body.length > 100000) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request too large' }));
      return;
    }
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  // Validate and sanitize inputs
  const article = sanitizeString(data.article, 50000);
  const audience = data.audience;
  const length = data.length;
  const focus = data.focus;

  // Validation
  if (!article || article.length < 50) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Article must be at least 50 characters' }));
    return;
  }

  if (!ALLOWED_AUDIENCES[audience]) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid audience selection' }));
    return;
  }

  if (!ALLOWED_LENGTHS.includes(length)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid length selection' }));
    return;
  }

  if (!ALLOWED_FOCUS[focus]) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid focus selection' }));
    return;
  }

  // Build prompt server-side
  const prompt = buildPrompt(article, audience, length, focus);

  // Call OpenAI API
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 1000
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!openaiRes.ok) {
      const status = openaiRes.status;
      console.error(`OpenAI API error: ${status}`);
      
      if (status === 429) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service temporarily unavailable. Please try again later.' }));
      } else if (status === 401) {
        console.error('Invalid OpenAI API key');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Service configuration error' }));
      } else {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to generate summary' }));
      }
      return;
    }

    const openaiData = await openaiRes.json();
    const summary = openaiData.choices?.[0]?.message?.content;

    if (!summary) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No summary generated' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ summary }));

  } catch (err) {
    if (err.name === 'AbortError') {
      res.writeHead(504, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Request timed out' }));
    } else {
      console.error('Error calling OpenAI:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
}

// ============================================================================
// STATIC FILE SERVING
// ============================================================================

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStaticFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': mimeType });
    res.end(data);
  });
}

// ============================================================================
// REQUEST HANDLER
// ============================================================================

const server = http.createServer(async (req, res) => {
  // Set security headers for all responses
  setSecurityHeaders(res);

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // API routes
  if (pathname === '/api/summarize' && req.method === 'POST') {
    await handleSummarize(req, res);
    return;
  }

  // Health check endpoint
  if (pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Static file serving (only GET)
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Prevent directory traversal attacks
  const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(__dirname, safePath === '/' ? 'index.html' : safePath);

  // Only serve files from the current directory
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  serveStaticFile(res, filePath);
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`OpenAI API key configured: ${OPENAI_API_KEY ? 'Yes' : 'No'}`);
  console.log('');
  console.log('Security features enabled:');
  console.log('  ✓ API key stored server-side (not exposed to client)');
  console.log('  ✓ Input validation and sanitization');
  console.log('  ✓ Rate limiting (10 requests/minute per IP)');
  console.log('  ✓ Request size limits');
  console.log('  ✓ Security headers (CSP, X-Frame-Options, etc.)');
  console.log('  ✓ Directory traversal protection');
  console.log('  ✓ Generic error messages (no sensitive data leakage)');
});
