import { Router } from "express";

const router = Router();

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");

router.get("/callback", (req, res) => {
  const code = trimString(req.query.code);
  const state = trimString(req.query.state);
  const error = trimString(req.query.error);
  const errorDescription = trimString(req.query.error_description);
  const status = error ? "error" : "success";

  const payload = {
    source: "google-oauth",
    type: "google-oauth-result",
    status,
    code,
    state,
    error,
    errorDescription,
    timestamp: new Date().toISOString(),
  };

  res.type("html").send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Google Login Callback</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f8fafc;
      color: #0f172a;
      display: grid;
      place-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .card {
      width: min(560px, 100%);
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 20px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
    }
    h1 {
      margin: 0 0 10px;
      font-size: 20px;
    }
    p {
      margin: 0;
      line-height: 1.6;
      color: #475569;
    }
    code {
      word-break: break-word;
      font-size: 12px;
      background: #f1f5f9;
      border-radius: 8px;
      padding: 8px;
      display: block;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>${escapeHtml(error ? "Google login failed" : "Google login complete")}</h1>
    <p>${escapeHtml(
      error
        ? errorDescription || "The Google authorization flow returned an error."
        : "You can close this window and continue in the app."
    )}</p>
    <code>${escapeHtml(JSON.stringify(payload))}</code>
  </main>
  <script>
    (function () {
      var payload = ${JSON.stringify(payload)};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, "*");
        }
      } catch (_) {}
      setTimeout(function () {
        window.close();
      }, 300);
    })();
  </script>
</body>
</html>`);
});

export default router;
