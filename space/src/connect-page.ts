const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

/**
 * Page the extension opens to obtain a pool token. The extension's content
 * script reads `#xtap-pool-token[data-token]`; humans see the manual
 * copy-paste fallback.
 */
export function renderConnectPage(username: string, token: string): string {
  const safeUser = escapeHtml(username);
  const safeToken = escapeHtml(token);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>xtap-pool — connect</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem; }
  code { background: #f0f0f0; padding: 0.15rem 0.35rem; border-radius: 4px; word-break: break-all; }
  .ok { color: #067a3c; font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { background: #101317; color: #e7e9ea; }
    code { background: #1f242b; }
    .ok { color: #4cd08a; }
  }
</style>
</head>
<body>
<h1>xtap-pool</h1>
<p class="ok" id="xtap-pool-status">Signed in as @${safeUser}.</p>
<div id="xtap-pool-token" data-username="${safeUser}" data-token="${safeToken}" hidden></div>
<p>If the xtap-pool extension is installed, it has picked up your pool token
automatically — you can close this tab and keep browsing X.</p>
<details>
<summary>Manual setup (fallback)</summary>
<p>Copy this token into the extension's options page:</p>
<p><code>${safeToken}</code></p>
</details>
</body>
</html>`;
}
