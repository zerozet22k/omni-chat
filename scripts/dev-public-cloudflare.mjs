import { spawn } from "node:child_process";
import process from "node:process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 4000);
const SERVER_START_CMD = process.env.SERVER_START_CMD || "npm run dev";
const REHOOK_ON_START = process.env.REHOOK_ON_START !== "false";
const REHOOK_WORKSPACE_ID = process.env.REHOOK_WORKSPACE_ID || "";
const REHOOK_AUTH_TOKEN = process.env.REHOOK_AUTH_TOKEN || "";
const ENV_PATH = path.resolve(process.cwd(), ".env");
const ENV_EXAMPLE_PATH = path.resolve(process.cwd(), ".env.example");

let cloudflared;
let server;
let rehookTriggered = false;

function splitCommand(command) {
  return command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((part) => {
    return part.replace(/^"|"$/g, "");
  }) || [];
}

function resolveCloudflaredCommand() {
  const explicit = process.env.CLOUDFLARED_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return explicit;
  }

  const localExe = path.resolve(process.cwd(), "bin", "cloudflared.exe");
  if (fs.existsSync(localExe)) {
    return localExe;
  }

  return "cloudflared";
}

function upsertPublicWebhookBaseUrl(publicUrl) {
  if (!publicUrl) {
    return;
  }

  if (!fs.existsSync(ENV_PATH) && fs.existsSync(ENV_EXAMPLE_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    console.log(`[env] created ${ENV_PATH} from .env.example`);
  }

  if (!fs.existsSync(ENV_PATH)) {
    fs.writeFileSync(ENV_PATH, `PUBLIC_WEBHOOK_BASE_URL=${publicUrl}\n`, "utf8");
    console.log(`[env] created ${ENV_PATH} with PUBLIC_WEBHOOK_BASE_URL`);
    return;
  }

  const current = fs.readFileSync(ENV_PATH, "utf8");
  const line = `PUBLIC_WEBHOOK_BASE_URL=${publicUrl}`;

  if (/^PUBLIC_WEBHOOK_BASE_URL=.*$/m.test(current)) {
    const updated = current.replace(/^PUBLIC_WEBHOOK_BASE_URL=.*$/m, line);
    if (updated !== current) {
      fs.writeFileSync(ENV_PATH, updated, "utf8");
      console.log("[env] updated PUBLIC_WEBHOOK_BASE_URL in .env");
    }
    return;
  }

  const separator = current.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(ENV_PATH, `${current}${separator}${line}\n`, "utf8");
  console.log("[env] appended PUBLIC_WEBHOOK_BASE_URL to .env");
}

function startServer(publicUrl) {
  if (server) return;

  upsertPublicWebhookBaseUrl(publicUrl);

  const [cmd, ...args] = splitCommand(SERVER_START_CMD);

  server = spawn(cmd, args, {
    env: {
      ...process.env,
      PORT: String(PORT),
      PUBLIC_WEBHOOK_BASE_URL: publicUrl,
    },
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  console.log(`\nPUBLIC_WEBHOOK_BASE_URL=${publicUrl}\n`);

  server.on("exit", (code) => {
    cleanup();
    process.exit(code ?? 0);
  });

  if (REHOOK_ON_START && !rehookTriggered) {
    rehookTriggered = true;
    void rehookWebhooks();
  }
}

async function rehookWebhooks() {
  if (!REHOOK_AUTH_TOKEN) {
    console.log("[rehook] skipped because REHOOK_AUTH_TOKEN is not set");
    return;
  }

  const endpoint = `http://127.0.0.1:${PORT}/api/channels/rehook`;
  const body = REHOOK_WORKSPACE_ID
    ? { workspaceId: REHOOK_WORKSPACE_ID }
    : {};

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${REHOOK_AUTH_TOKEN}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text();
        console.warn(`[rehook] request failed (${response.status}): ${text}`);
      } else {
        const payload = await response.json();
        console.log(`[rehook] updated ${payload.updated ?? 0} connection(s)`);
      }
      return;
    } catch {
      // Wait for server startup and retry.
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  console.warn("[rehook] unable to reach local server after startup; skipping webhook rehook");
}

function cleanup() {
  if (server && !server.killed) {
    server.kill("SIGTERM");
  }

  if (cloudflared && !cloudflared.killed) {
    cloudflared.kill("SIGTERM");
  }
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

const cloudflaredCmd = resolveCloudflaredCommand();

cloudflared = spawn(
  cloudflaredCmd,
  ["tunnel", "--url", `http://localhost:${PORT}`],
  {
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  }
);

const handleOutput = (chunk) => {
  const text = chunk.toString();
  process.stdout.write(text);

  const match = text.match(/https:\/\/[-a-zA-Z0-9]+\.trycloudflare\.com/);
  if (match) {
    startServer(match[0]);
  }
};

cloudflared.stdout.on("data", handleOutput);
cloudflared.stderr.on("data", handleOutput);

cloudflared.on("error", (error) => {
  console.error(`Failed to start ${cloudflaredCmd}:`, error.message);
  process.exit(1);
});

cloudflared.on("exit", (code) => {
  if (!server) {
    console.error("cloudflared exited before a public URL was detected.");
  }
  cleanup();
  process.exit(code ?? 1);
});