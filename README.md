# ai-article-summarizer
A simple webapp that turns an article into clear and structured summaries

I've secured the application for production. Here's a summary of the security improvements:

## Security Changes Made

### 1. **API Key Protection** (Critical Fix)
- ❌ **Before**: API key exposed in client-side JavaScript
- ✅ **After**: API key stored server-side via `OPENAI_API_KEY` environment variable

### 2. **New Backend Server** (`server.js`)
Created a secure Node.js server with:
- **Rate limiting**: 10 requests/minute per IP
- **Request size limits**: Max 100KB request body
- **Input validation**: Whitelist-based validation for all parameters
- **Directory traversal protection**: Prevents `../` path attacks
- **Request timeouts**: 60-second timeout for API calls
- **Generic error messages**: No sensitive data leakage

### 3. **Security Headers**
- `Content-Security-Policy` (CSP)
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `X-XSS-Protection: 1; mode=block`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy` (disables geolocation, mic, camera)

### 4. **Frontend Improvements** (`index.html`)
- Subresource Integrity (SRI) hash for Bootstrap CDN
- Client-side input validation
- Client-side rate limiting (3-second delay)
- Character count limits (50,000 max)
- Request timeout handling
- IIFE pattern to avoid global scope pollution

### 5. **Configuration Files**
- `.env.example` - Documents required environment variables
- `.gitignore` - Prevents accidental commit of `.env` secrets

## How to Deploy

```bash
# Set your OpenAI API key
export OPENAI_API_KEY="sk-your-key-here"

# Start the server
node server.js
```

**Note**: The summarization feature requires you to set the `OPENAI_API_KEY` environment variable before it will work.
