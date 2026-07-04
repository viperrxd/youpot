const express = require("express");
const puppeteer = require("puppeteer");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const SELF_PING_INTERVAL = 14 * 60 * 1000; // 14 minutes — keeps free tier alive

// ─── State ───────────────────────────────────────────────────────────────────
let browser = null;
let cachedToken = null;
let cachedTokenExpiry = 0;
let isRefreshing = false;

// ─── Browser Management ─────────────────────────────────────────────────────
async function launchBrowser() {
  if (browser) {
    try {
      await browser.close();
    } catch (_) {
      /* ignore */
    }
  }

  console.log("[browser] Launching headless Chrome...");
  const launchOptions = {
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-sync",
      "--disable-translate",
      "--no-first-run",
      "--disable-crash-reporter",
      "--disable-breakpad",
      "--disable-component-update",
      "--disable-features=VizDisplayCompositor,CrashReporting",
    ],
    env: {
      ...process.env,
      CHROME_CRASHPAD_PIPE_NAME: "",
    },
  };

  // Use system Chromium when set (Docker)
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  browser = await puppeteer.launch(launchOptions);
  browser.on("disconnected", () => {
    console.warn("[browser] Chrome disconnected, will relaunch on next request");
    browser = null;
  });

  console.log("[browser] Chrome launched successfully");
  return browser;
}

async function ensureBrowser() {
  if (!browser || !browser.connected) {
    await launchBrowser();
  }
  return browser;
}

// ─── Token Fetching ─────────────────────────────────────────────────────────
async function fetchYouTubeToken() {
  const b = await ensureBrowser();
  const page = await b.newPage();

  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125.0.0.0 Safari/537.36"
    );

    // Bypass EU consent screen
    await page.setCookie({
      name: "CONSENT",
      value: "YES+cb.20210328-17-p0.en+FX+971",
      domain: ".youtube.com",
    });

    await page.setRequestInterception(true);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Token fetch timed out after 45 seconds"));
      }, 45000);

      page.on("request", (req) => {
        const url = req.url();

        // Intercept YouTube API requests that carry the poToken
        if (url.includes("/youtubei/v1/") && req.method() === "POST") {
          try {
            const postData = req.postData();
            if (postData) {
              const body = JSON.parse(postData);
              const poToken = body?.serviceIntegrityDimensions?.poToken;
              const visitorData = body?.context?.client?.visitorData;

              if (poToken && visitorData) {
                clearTimeout(timeout);
                console.log("[token] Got poToken and visitorData from YouTube API request");
                resolve({ poToken, visitorData });
              }
            }
          } catch (_) {
            /* not a JSON body, ignore */
          }
        }

        req.continue();
      });

      // Navigate to a video page — this triggers YouTube's BotGuard + player API
      page.goto("https://www.youtube.com/watch?v=jNQXAC9IVRw", {
        waitUntil: "networkidle2",
        timeout: 40000,
      }).then(async () => {
        // Fallback: if interception didn't catch it, try extracting from page context
        await new Promise((r) => setTimeout(r, 5000));

        try {
          const pageData = await page.evaluate(() => {
            const visitorData = window.ytcfg?.data_?.VISITOR_DATA;
            // Look for poToken in various places YouTube might store it
            const ytInitData = window.ytInitialPlayerResponse;
            const poToken = ytInitData?.serviceIntegrityDimensions?.poToken;
            return { visitorData, poToken };
          });

          if (pageData.poToken && pageData.visitorData) {
            clearTimeout(timeout);
            console.log("[token] Got tokens from page context (fallback)");
            resolve(pageData);
          }
        } catch (_) {
          /* page might have navigated away */
        }
      }).catch(() => {
        /* navigation error handled by timeout */
      });
    });
  } finally {
    try {
      await page.close();
    } catch (_) {
      /* ignore */
    }
  }
}

async function getToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    console.log("[token] Returning cached token");
    return cachedToken;
  }

  // Prevent concurrent refreshes
  if (isRefreshing) {
    console.log("[token] Already refreshing, waiting...");
    await new Promise((r) => setTimeout(r, 2000));
    if (cachedToken && Date.now() < cachedTokenExpiry) {
      return cachedToken;
    }
  }

  isRefreshing = true;
  try {
    console.log("[token] Fetching fresh token from YouTube...");
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
    console.error("[error] Failed to get token:", err.message);

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
    browserConnected: browser?.connected ?? false,
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
  const externalUrl =
    process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) return;

  const protocol = externalUrl.startsWith("http") ? "" : "https://";
  const url = `${protocol}${externalUrl}/health`;
  console.log(`[ping] Self-ping enabled every 14 min → ${url}`);

  setInterval(async () => {
    try {
      await fetch(url);
      console.log("[ping] Self-ping OK");
    } catch (err) {
      console.warn("[ping] Self-ping failed:", err.message);
    }
  }, SELF_PING_INTERVAL);
}

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║       YouPOT Token Server v1.0.0        ║");
  console.log("║   For Lavalink / youtube-source plugin   ║");
  console.log("╚══════════════════════════════════════════╝");

  // Pre-launch browser
  await launchBrowser();

  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(
      `[server] Token endpoint: http://localhost:${PORT}/api/token`
    );
    startSelfPing();
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────
async function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, closing...`);
  if (browser) {
    try {
      await browser.close();
    } catch (_) {
      /* ignore */
    }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Start the server
start().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
