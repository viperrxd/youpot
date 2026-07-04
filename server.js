const express = require("express");
const puppeteer = require("puppeteer");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 8080;
const SELF_PING_INTERVAL = 14 * 60 * 1000;

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

  console.log("[browser] Launching headless Chrome (Stealth Mode)...");
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
      "--disable-blink-features=AutomationControlled", // Hides Puppeteer
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
    // 1. Stealth: Override webdriver property before the page loads
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
      // Mock plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3],
      });
      // Mock languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });
    });

    // 2. Realistic Headers
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
    );
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    });

    // 3. Bypass EU consent screen
    await page.setCookie({
      name: "CONSENT",
      value: "YES+cb.20210328-17-p0.en+FX+971",
      domain: ".youtube.com",
    });

    await page.setRequestInterception(true);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Token fetch timed out after 45 seconds (BotGuard might be blocking the IP)"));
      }, 45000);

      page.on("request", (req) => {
        const url = req.url();

        // We listen for API calls containing poToken
        if (url.includes("/youtubei/v1/") && req.method() === "POST") {
          try {
            const postData = req.postData();
            if (postData) {
              const body = JSON.parse(postData);
              const poToken = body?.serviceIntegrityDimensions?.poToken;
              const visitorData = body?.context?.client?.visitorData;

              if (poToken && visitorData) {
                clearTimeout(timeout);
                console.log("[token] Success! Extracted poToken from YouTube API request.");
                resolve({ poToken, visitorData });
              }
            }
          } catch (_) { /* ignore non-JSON */ }
        }
        req.continue();
      });

      // Navigate to YouTube Embed (Lighter page, skips many checks, still triggers BotGuard)
      console.log("[token] Navigating to YouTube Embed page...");
      page.goto("https://www.youtube.com/embed/jNQXAC9IVRw", {
        waitUntil: "domcontentloaded",
        timeout: 40000,
      }).then(async () => {
        // Wait 5 seconds to give BotGuard time to execute and fire the API request
        await new Promise((r) => setTimeout(r, 5000));

        // Fallback: Check if it's stored in window objects
        try {
          const pageData = await page.evaluate(() => {
            const visitorData = window.ytcfg?.data_?.VISITOR_DATA;
            const ytInitData = window.ytInitialPlayerResponse;
            const poToken = ytInitData?.serviceIntegrityDimensions?.poToken;
            const title = document.title;
            return { visitorData, poToken, title };
          });

          if (pageData.poToken && pageData.visitorData) {
            clearTimeout(timeout);
            console.log("[token] Success! Extracted tokens directly from page context.");
            resolve(pageData);
          } else {
            console.log(`[token] Still waiting... Page loaded but no tokens yet. Title: "${pageData.title}"`);
            
            // If the title contains "consent" or "captcha", YouTube is blocking the view
            if (pageData.title.toLowerCase().includes("before you continue") || pageData.title.toLowerCase().includes("captcha")) {
               console.warn("[token] WARNING: YouTube served a Captcha or Consent page. This IP might be heavily blocked.");
            }
          }
        } catch (err) {
          console.log(`[token] Evaluate fallback error: ${err.message}`);
        }
      }).catch((err) => {
        console.log(`[token] Navigation error: ${err.message}`);
      });
    });
  } finally {
    try {
      await page.close();
    } catch (_) { /* ignore */ }
  }
}

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  if (isRefreshing) {
    await new Promise((r) => setTimeout(r, 2000));
    if (cachedToken && Date.now() < cachedTokenExpiry) {
      return cachedToken;
    }
  }

  isRefreshing = true;
  try {
    console.log("[token] Fetching fresh token from YouTube...");
    const token = await fetchYouTubeToken();

    cachedToken = token;
    cachedTokenExpiry = Date.now() + 6 * 60 * 60 * 1000;

    return token;
  } finally {
    isRefreshing = false;
  }
}

// ─── Express Server ─────────────────────────────────────────────────────────
const app = express();

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/token", async (req, res) => {
  try {
    const token = await getToken();
    res.json(token);
  } catch (err) {
    console.error("[error] Failed to get token:", err.message);
    cachedToken = null;
    cachedTokenExpiry = 0;
    res.status(500).json({
      error: "Failed to fetch YouTube token",
      message: err.message,
    });
  }
});

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

// ─── Self-Ping ──────────────────────────────────────────────────────────────
function startSelfPing() {
  const externalUrl = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) return;

  const protocol = externalUrl.startsWith("http") ? "" : "https://";
  const url = `${protocol}${externalUrl}/health`;

  setInterval(async () => {
    try { await fetch(url); } catch (_) { /* ignore */ }
  }, SELF_PING_INTERVAL);
}

// ─── Startup ────────────────────────────────────────────────────────────────
async function start() {
  await launchBrowser();

  app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] Token endpoint: http://localhost:${PORT}/api/token`);
    startSelfPing();
  });
}

async function shutdown(signal) {
  console.log(`\n[shutdown] Received ${signal}, closing...`);
  if (browser) {
    try { await browser.close(); } catch (_) { }
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
