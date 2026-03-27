import express, { Router } from "express";
import { env } from "../../config/env";
import { asyncHandler } from "../../lib/async-handler";
import { parseFacebookSignedRequest } from "../../lib/meta-signed-request";

const router = Router();

router.use(express.urlencoded({ extended: false }));

const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const renderPage = ({
  title,
  body,
}: {
  title: string;
  body: string;
}) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
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
      width: min(720px, 100%);
      background: white;
      border: 1px solid #e2e8f0;
      border-radius: 16px;
      padding: 24px;
      box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08);
    }
    h1 {
      margin: 0 0 12px;
      font-size: 24px;
    }
    p {
      margin: 0 0 12px;
      line-height: 1.6;
      color: #475569;
    }
    code {
      word-break: break-word;
      font-size: 12px;
      background: #e2e8f0;
      border-radius: 8px;
      padding: 2px 6px;
    }
  </style>
</head>
<body>
  <main class="card">
    ${body}
  </main>
</body>
</html>`;

router.get("/facebook", (_req, res) => {
  res.type("html").send(
    renderPage({
      title: "Facebook Deauthorize Callback",
      body: `
        <h1>Facebook Deauthorize Callback</h1>
        <p>This endpoint is configured for Meta deauthorization callbacks associated with Facebook Login.</p>
        <p>When a person removes the app, Meta can send a signed request to this URL so the app can acknowledge the deauthorization event.</p>
        <p><strong>Callback URL:</strong> <code>/meta/deauthorize/facebook</code></p>
      `,
    })
  );
});

router.post(
  "/facebook",
  asyncHandler(async (req, res) => {
    const signedRequest = trimString(req.body?.signed_request);
    if (!signedRequest) {
      res.status(400).json({
        error: "signed_request is required",
      });
      return;
    }

    try {
      parseFacebookSignedRequest(signedRequest, trimString(env.META_APP_SECRET));
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid signed request",
      });
      return;
    }

    res.json({ success: true });
  })
);

export default router;
