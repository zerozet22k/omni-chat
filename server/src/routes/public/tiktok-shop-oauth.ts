import { Router } from "express";
import { tiktokShopAuthService } from "../../services/tiktok-shop-auth.service";

const router = Router();

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatJson = (value: unknown) => JSON.stringify(value, null, 2);

const renderPage = (params: {
  title: string;
  statusCode?: number;
  summary: string;
  state?: string;
  code?: string;
  details?: Record<string, unknown>;
  sensitivePayload?: Record<string, unknown> | null;
}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(params.title)}</title>
  <style>
    :root {
      color-scheme: light;
      font-family: Arial, sans-serif;
    }
    body {
      margin: 0;
      background: #f6f3eb;
      color: #1f2937;
    }
    main {
      max-width: 760px;
      margin: 48px auto;
      padding: 0 20px;
    }
    .card {
      background: #fffdf8;
      border: 1px solid #d6cfbf;
      border-radius: 18px;
      padding: 24px;
      box-shadow: 0 18px 50px rgba(64, 50, 24, 0.08);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 30px;
      line-height: 1.15;
    }
    p {
      margin: 0 0 14px;
      line-height: 1.6;
    }
    dl {
      display: grid;
      grid-template-columns: minmax(120px, 180px) 1fr;
      gap: 10px 14px;
      margin: 18px 0 0;
    }
    dt {
      font-weight: 700;
    }
    dd {
      margin: 0;
      word-break: break-word;
    }
    code, pre {
      font-family: "Courier New", monospace;
      font-size: 13px;
    }
    pre {
      margin: 0;
      overflow: auto;
      padding: 14px;
      border-radius: 12px;
      background: #1f2937;
      color: #f9fafb;
    }
    .note {
      margin-top: 18px;
      padding: 14px 16px;
      border-radius: 12px;
      background: #f5efe1;
      border: 1px solid #e8dcc0;
    }
    details {
      margin-top: 18px;
    }
    summary {
      cursor: pointer;
      font-weight: 700;
      margin-bottom: 10px;
    }
  </style>
</head>
<body>
  <main>
    <section class="card">
      <h1>${escapeHtml(params.title)}</h1>
      <p>${escapeHtml(params.summary)}</p>
      <p>This helper is for TikTok Shop Open API authorization only. It does not connect the existing TikTok Business Messaging inbox integration in this app.</p>
      <dl>
        <dt>Redirect URL</dt>
        <dd><code>${escapeHtml(
          tiktokShopAuthService.getRedirectUrl() || "PUBLIC_WEBHOOK_BASE_URL is not configured"
        )}</code></dd>
        <dt>State</dt>
        <dd><code>${escapeHtml(params.state || "(empty)")}</code></dd>
        <dt>Code</dt>
        <dd><code>${escapeHtml(params.code || "(empty)")}</code></dd>
      </dl>
      ${
        params.details
          ? `<div class="note"><pre>${escapeHtml(formatJson(params.details))}</pre></div>`
          : ""
      }
      ${
        params.sensitivePayload
          ? `<details>
        <summary>Sensitive token values</summary>
        <pre>${escapeHtml(formatJson(params.sensitivePayload))}</pre>
      </details>`
          : ""
      }
    </section>
  </main>
</body>
</html>`;

router.get("/callback", async (req, res) => {
  const format = trimString(req.query.format).toLowerCase();
  const code = trimString(req.query.code);
  const state = trimString(req.query.state);
  const error = trimString(req.query.error);
  const errorDescription = trimString(
    req.query.error_description ?? req.query.message
  );

  const wantsJson =
    format === "json" ||
    (format !== "html" && req.accepts(["html", "json"]) === "json");

  if (error) {
    const payload = {
      ok: false,
      stage: "authorization_denied",
      error,
      errorDescription: errorDescription || "TikTok Shop authorization was rejected.",
      state,
      code: code || null,
      redirectUrl: tiktokShopAuthService.getRedirectUrl() || null,
    };

    if (wantsJson) {
      res.status(400).json(payload);
      return;
    }

    res
      .status(400)
      .type("html")
      .send(
        renderPage({
          title: "TikTok Shop Authorization Rejected",
          statusCode: 400,
          summary:
            errorDescription || "TikTok Shop returned an authorization error.",
          state,
          code,
          details: payload,
        })
      );
    return;
  }

  if (!code || code.toLowerCase() === "null") {
    const payload = {
      ok: false,
      stage: "missing_code",
      error: "missing_code",
      errorDescription:
        "TikTok Shop did not include a usable authorization code in the redirect.",
      state,
      code: code || null,
      redirectUrl: tiktokShopAuthService.getRedirectUrl() || null,
    };

    if (wantsJson) {
      res.status(400).json(payload);
      return;
    }

    res
      .status(400)
      .type("html")
      .send(
        renderPage({
          title: "TikTok Shop Authorization Incomplete",
          summary: payload.errorDescription,
          state,
          code,
          details: payload,
        })
      );
    return;
  }

  if (!tiktokShopAuthService.hasAppConfig()) {
    const payload = {
      ok: true,
      stage: "callback_received",
      state,
      code,
      redirectUrl: tiktokShopAuthService.getRedirectUrl() || null,
      tokenExchange: {
        configured: false,
        message:
          "Set TIKTOK_SHOP_APP_KEY and TIKTOK_SHOP_APP_SECRET on the server to exchange this code automatically.",
      },
    };

    if (wantsJson) {
      res.json(payload);
      return;
    }

    res
      .status(200)
      .type("html")
      .send(
        renderPage({
          title: "TikTok Shop Callback Received",
          summary:
            "The authorization code was captured successfully, but server-side token exchange is not configured yet.",
          state,
          code,
          details: payload,
        })
      );
    return;
  }

  try {
    const tokens = await tiktokShopAuthService.exchangeAuthorizationCode(code);
    const payload = {
      ok: true,
      stage: "token_exchanged",
      state,
      code,
      redirectUrl: tiktokShopAuthService.getRedirectUrl() || null,
      tokenExchange: {
        configured: true,
      },
      tokens,
    };

    if (wantsJson) {
      res.json(payload);
      return;
    }

    res
      .status(200)
      .type("html")
      .send(
        renderPage({
          title: "TikTok Shop Authorization Complete",
          summary:
            "The authorization code was exchanged successfully. Copy the token data somewhere safe if you still need it.",
          state,
          code,
          details: {
            openId: tokens.openId || null,
            sellerName: tokens.sellerName || null,
            sellerBaseRegion: tokens.sellerBaseRegion || null,
            userType: tokens.userType,
            grantedScopes: tokens.grantedScopes,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
            refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
          },
          sensitivePayload: payload.tokens,
        })
      );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "TikTok Shop token exchange failed.";
    const payload = {
      ok: false,
      stage: "token_exchange_failed",
      error: "token_exchange_failed",
      errorDescription: message,
      state,
      code,
      redirectUrl: tiktokShopAuthService.getRedirectUrl() || null,
    };

    if (wantsJson) {
      res.status(400).json(payload);
      return;
    }

    res
      .status(400)
      .type("html")
      .send(
        renderPage({
          title: "TikTok Shop Token Exchange Failed",
          summary: message,
          state,
          code,
          details: payload,
        })
      );
  }
});

export default router;
