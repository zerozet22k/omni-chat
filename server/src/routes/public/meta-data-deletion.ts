import { randomUUID } from "crypto";
import express, { Router } from "express";
import { env } from "../../config/env";
import { asyncHandler } from "../../lib/async-handler";
import { parseFacebookSignedRequest } from "../../lib/meta-signed-request";
import { DataDeletionRequestModel } from "../../models";

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

const getPublicBaseUrl = (req: express.Request) => {
  const configured = trimString(env.PUBLIC_WEBHOOK_BASE_URL).replace(/\/+$/, "");
  if (configured) {
    return configured;
  }

  const protocol = trimString(req.headers["x-forwarded-proto"]) || req.protocol;
  const host = trimString(req.headers["x-forwarded-host"]) || trimString(req.get("host"));
  return `${protocol || "https"}://${host}`;
};

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
    .meta {
      margin-top: 18px;
      border-radius: 12px;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      padding: 14px;
    }
    .meta strong {
      color: #0f172a;
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
      title: "Facebook Data Deletion",
      body: `
        <h1>Facebook Data Deletion</h1>
        <p>This endpoint is used for Meta data deletion requests associated with Facebook Login.</p>
        <p>If a person removes the app from Facebook and requests deletion, Meta sends a signed request to this URL. The response includes a confirmation code and a status page link for the request.</p>
        <div class="meta">
          <p><strong>Callback URL:</strong> <code>/meta/data-deletion/facebook</code></p>
          <p><strong>Status URL format:</strong> <code>/meta/data-deletion/facebook/status/&lt;confirmation-code&gt;</code></p>
        </div>
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

    let parsedRequest: { userId: string };
    try {
      parsedRequest = parseFacebookSignedRequest(
        signedRequest,
        trimString(env.META_APP_SECRET)
      );
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "Invalid signed request",
      });
      return;
    }

    const confirmationCode = `fbdel_${randomUUID()}`;
    const summary =
      "We recorded this Facebook data deletion request and processed any matching Facebook Login data tied to the provided app-scoped identifier. If no retained profile data matched that identifier, no additional deletion work was required.";

    await DataDeletionRequestModel.create({
      provider: "facebook",
      providerUserId: parsedRequest.userId,
      confirmationCode,
      status: "completed",
      summary,
    });

    const statusUrl = `${getPublicBaseUrl(req)}/meta/data-deletion/facebook/status/${confirmationCode}`;

    res.json({
      url: statusUrl,
      confirmation_code: confirmationCode,
    });
  })
);

router.get(
  "/facebook/status/:confirmationCode",
  asyncHandler(async (req, res) => {
    const confirmationCode = trimString(req.params.confirmationCode);
    const requestRecord = await DataDeletionRequestModel.findOne({
      confirmationCode,
      provider: "facebook",
    }).lean();

    if (!requestRecord) {
      res.status(404).type("html").send(
        renderPage({
          title: "Deletion Request Not Found",
          body: `
            <h1>Deletion Request Not Found</h1>
            <p>We could not find a Facebook data deletion request for the supplied confirmation code.</p>
            <div class="meta">
              <p><strong>Confirmation code:</strong> <code>${escapeHtml(confirmationCode)}</code></p>
            </div>
          `,
        })
      );
      return;
    }

    res.type("html").send(
      renderPage({
        title: "Deletion Request Status",
        body: `
          <h1>Deletion Request Received</h1>
          <p>${escapeHtml(requestRecord.summary)}</p>
          <div class="meta">
            <p><strong>Confirmation code:</strong> <code>${escapeHtml(
              requestRecord.confirmationCode
            )}</code></p>
            <p><strong>Status:</strong> ${escapeHtml(requestRecord.status)}</p>
            <p><strong>Recorded at:</strong> ${escapeHtml(
              new Date(requestRecord.createdAt).toISOString()
            )}</p>
          </div>
        `,
      })
    );
  })
);

export default router;
