/**
 * Tiny server-rendered pages for the redirect domain (password prompt, gone,
 * not found, rate limited). They are served by the API itself so the redirect
 * path has no dependency on the dashboard SPA. No external assets.
 */

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · LinkPulse</title>
<style>
  :root { --bg:#f6f7fb; --card:#fff; --text:#0f172a; --muted:#5b6475; --accent:#5b4cf0; --accent-ink:#fff; --border:#e3e6ef; --danger:#c2253d; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0b0e17; --card:#131826; --text:#e8ebf5; --muted:#9aa3b8; --border:#252c3f; --accent:#8b7fff; --accent-ink:#0b0e17; --danger:#ff7a8e; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border); border-radius:16px; padding:32px;
         box-shadow: 0 12px 32px -12px rgba(15,23,42,.18); }
  .brand { display:flex; align-items:center; gap:8px; font-weight:700; letter-spacing:-.01em; margin-bottom:24px; }
  .dot { width:10px; height:10px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px color-mix(in srgb, var(--accent) 22%, transparent); }
  .code { font-size:14px; font-weight:600; color:var(--accent); letter-spacing:.04em; text-transform:uppercase; margin:0 0 4px; }
  h1 { font-size:24px; line-height:1.25; margin:0 0 8px; letter-spacing:-.02em; }
  p { color:var(--muted); margin:0 0 20px; }
  label { display:block; font-weight:600; font-size:14px; margin-bottom:6px; }
  input { width:100%; font:inherit; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:transparent; color:inherit; }
  input:focus-visible, button:focus-visible, a:focus-visible { outline:3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset:2px; }
  button, .btn { display:inline-flex; justify-content:center; width:100%; margin-top:16px; font:inherit; font-weight:600; padding:10px 16px; border:0;
           border-radius:10px; background:var(--accent); color:var(--accent-ink); cursor:pointer; text-decoration:none; }
  .error { color:var(--danger); font-size:14px; margin:8px 0 0; }
  .meter { height:6px; border-radius:99px; background:var(--border); overflow:hidden; margin: 4px 0 20px; }
  .meter span { display:block; height:100%; background:var(--accent); width:100%; transform-origin:left; }
  @media (prefers-reduced-motion: no-preference) { .meter span { animation: drain var(--wait, 10s) linear forwards; } }
  @keyframes drain { to { transform: scaleX(0); } }
  footer { margin-top:24px; font-size:13px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <div class="brand"><span class="dot" aria-hidden="true"></span>LinkPulse</div>
  ${body}
  <footer>Short links with real-time analytics.</footer>
</main>
</body>
</html>`;
}

export function passwordPage(code: string, error?: string): string {
  return layout(
    'Protected link',
    `<p class="code">Protected link</p>
  <h1>Enter the password to continue</h1>
  <p>The owner of <strong>/${esc(code)}</strong> protected this link with a password.</p>
  <form method="post" action="/${encodeURIComponent(code)}">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required autofocus
      ${error ? 'aria-invalid="true" aria-describedby="pw-error"' : ''}>
    ${error ? `<p class="error" id="pw-error" role="alert">${esc(error)}</p>` : ''}
    <button type="submit">Continue</button>
  </form>`,
  );
}

const GONE_COPY = {
  disabled: ['Link disabled', 'The owner has disabled this link.'],
  expired: ['Link expired', 'This link had an expiry date and is no longer active.'],
  limit_reached: ['Link limit reached', 'This link could only be opened a limited number of times, and that limit has been reached.'],
} as const;

export function gonePage(reason: keyof typeof GONE_COPY): string {
  const [title, text] = GONE_COPY[reason];
  return layout(title, `<p class="code">410 · Gone</p><h1>${title}</h1><p>${text}</p>`);
}

export function notFoundPage(): string {
  return layout(
    'Link not found',
    `<p class="code">404 · Not found</p><h1>This short link doesn't exist</h1><p>Check the address for typos: short codes are case-sensitive.</p>`,
  );
}

export function rateLimitedPage(retryAfterSeconds: number): string {
  return layout(
    'Too many requests',
    `<p class="code">429 · Rate limited</p>
  <h1>Slow down a little</h1>
  <p>Too many requests came from your network in a short time. You can try again in
    <strong><span id="s">${retryAfterSeconds}</span> seconds</strong>.</p>
  <div class="meter" style="--wait:${retryAfterSeconds}s" aria-hidden="true"><span></span></div>
  <a class="btn" href="" id="retry">Try again</a>
  <script>
    (function(){var n=${retryAfterSeconds},s=document.getElementById('s');
    var t=setInterval(function(){n=Math.max(0,n-1);s.textContent=n;if(!n)clearInterval(t)},1000);})();
  </script>`,
  );
}
