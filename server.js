const express = require("express");
const { generate } = require("youtube-po-token-generator");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const SELF_PING_INTERVAL = 14 * 60 * 1000; // 14 minutes — keeps free tier alive

// ─── State ───────────────────────────────────────────────────────────────────
let cachedToken = null;
let cachedTokenExpiry = 0;
let isRefreshing = false;

// ─── Token Fetching ─────────────────────────────────────────────────────────
async function fetchYouTubeToken() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Token fetch timed out after 30 seconds"));
    }, 30000);

    generate()
      .then((result) => {
        clearTimeout(timeout);

        if (!result.poToken || !result.visitorData) {
          reject(new Error("Invalid token response from YouTube"));
          return;
        }

        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to generate token: ${err.message}`));
      });
  });
}

async function getToken() {
  // Return cached token if still valid (cache for 6 hours)
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  // Prevent concurrent refreshes
  if (isRefreshing) {
    await new Promise((r) => setTimeout(r, 2000));
    if (cachedToken && Date.now() < cachedTokenExpiry) {
      return cachedToken;
    }
  }

  isRefreshing = true;
  try {
    const token = await fetchYouTubeToken();

    // Cache the token for 6 hours
    cachedToken = token;
    cachedTokenExpiry = Date.now() + 6 * 60 * 60 * 1000;

    return token;
  } finally {
    isRefreshing = false;
  }
}

// ─── Express Server ─────────────────────────────────────────────────────────
const app = express();

// CORS — allow access from anywhere
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// GET /api/token — the main endpoint
app.get("/api/token", async (req, res) => {
  try {
    const token = await getToken();
    res.json(token);
  } catch (err) {
    // Invalidate cache on error so next request retries
    cachedToken = null;
    cachedTokenExpiry = 0;

    res.status(500).json({
      error: "Failed to fetch YouTube token",
      message: err.message,
    });
  }
});

// GET /health — health check
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    tokenCached: cachedToken !== null,
    tokenExpiresIn: cachedToken
      ? Math.round((cachedTokenExpiry - Date.now()) / 1000)
      : null,
  });
});

// GET / — info page
app.get("/", (req, res) => {
  res.json({
    service: "youpot",
    version: "1.0.0",
    endpoints: {
      token: "/api/token",
      health: "/health",
    },
  });
});

// ─── Self-Ping (keeps free tier alive) ───────────────────────────────────────
function startSelfPing() {
  const externalUrl = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) return;

  const protocol = externalUrl.startsWith("http") ? "" : "https://";
  const url = `${protocol}${externalUrl}/health`;

  setInterval(async () => {
    try {
      await fetch(url);
    } catch (_) {
      /* ignore */
    }
  }, SELF_PING_INTERVAL);
}

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  // Pre-fetch first token so it's cached immediately
  try {
    await getToken();
  } catch (_) {
    /* will retry on first request */
  }

  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] Token endpoint: http://localhost:${PORT}/api/token`);
    startSelfPing();
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

// Start the server
start().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
