const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

// Enable stealth plugin
puppeteer.use(StealthPlugin());

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
    try { await browser.close(); } catch (_) { }
  }

  console.log("[browser] Launching headless Chrome with full Stealth mode...");
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
      "--disable-blink-features=AutomationControlled",
    ],
    env: { ...process.env, CHROME_CRASHPAD_PIPE_NAME: "" },
  };

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
    // 1. Bypass EU consent screen explicitly
    await page.setCookie({
      name: "CONSENT",
      value: "YES+cb.20210328-17-p0.en+FX+971",
      domain: ".youtube.com",
    });

    await page.setRequestInterception(true);

    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Token fetch timed out after 45 seconds (YouTube might be strictly blocking this IP)"));
      }, 45000);

      let interceptedVisitorData = null;

      page.on("request", (req) => {
        const url = req.url();
        
        // 1. Check for 'pot' in URL query parameters (like timedtext or videoplayback)
        try {
          const urlObj = new URL(url);
          const potParam = urlObj.searchParams.get("pot");
          if (potParam) {
            console.log("[token] Success! Found 'pot' parameter in URL:", url.split("?")[0]);
            
            // We need visitorData too, let's grab it from the page context
            page.evaluate(() => window.ytcfg?.data_?.VISITOR_DATA).then((vData) => {
              if (vData) {
                clearTimeout(timeout);
                resolve({ poToken: potParam, visitorData: vData });
              }
            }).catch(() => {});
          }
        } catch (_) {}

        // 2. Check for poToken in POST payloads (youtubei/v1/)
        if (url.includes("/youtubei/v1/") && req.method() === "POST") {
          try {
            const postData = req.postData();
            if (postData) {
              const body = JSON.parse(postData);
              const poToken = body?.serviceIntegrityDimensions?.poToken;
              const visitorData = body?.context?.client?.visitorData;

              if (visitorData) interceptedVisitorData = visitorData;

              if (poToken && visitorData) {
                clearTimeout(timeout);
                console.log("[token] Success! Extracted poToken from YouTube API POST request.");
                resolve({ poToken, visitorData });
              }
            }
          } catch (_) {}
        }
        req.continue();
      });

      console.log("[token] Navigating to YouTube watch page...");
      
      // Navigate to the YouTube page
      page.goto("https://www.youtube.com/watch?v=4NRXx6U8ABQ", {
        waitUntil: "domcontentloaded",
        timeout: 40000,
      }).then(async (response) => {
        console.log(`[token] Page response status: ${response ? response.status() : 'Unknown'}`);
        
        // Give BotGuard time to execute
        await new Promise((r) => setTimeout(r, 5000));

        try {
          const pageData = await page.evaluate(() => {
            const visitorData = window.ytcfg?.data_?.VISITOR_DATA;
            const ytInitData = window.ytInitialPlayerResponse;
            const poToken = ytInitData?.serviceIntegrityDimensions?.poToken;
            const title = document.title;
            const htmlSample = document.body.innerHTML.substring(0, 150); // grab a snippet for debugging
            return { visitorData, poToken, title, htmlSample };
          });

          if (pageData.poToken && pageData.visitorData) {
            clearTimeout(timeout);
            console.log("[token] Success! Extracted tokens directly from page context.");
            resolve(pageData);
          } else {
            console.log(`[token] No tokens found yet. Title: "${pageData.title}"`);
            if (!pageData.title || pageData.title.startsWith("http")) {
              console.log("[token] Debug HTML Snippet: ", pageData.htmlSample.replace(/\n/g, ' '));
              console.log("[token] Warning: YouTube is not rendering the HTML document properly.");
            }
          }
        } catch (err) {
          console.log(`[token] Evaluate error: ${err.message}`);
        }
      }).catch((err) => {
        console.log(`[token] Navigation error: ${err.message}`);
      });
    });
  } finally {
    try { await page.close(); } catch (_) {}
  }
}

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  if (isRefreshing) {
    await new Promise((r) => setTimeout(r, 2000));
    if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
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
    res.status(500).json({ error: "Failed to fetch YouTube token", message: err.message });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    browserConnected: browser?.connected ?? false,
    tokenCached: cachedToken !== null,
    tokenExpiresIn: cachedToken ? Math.round((cachedTokenExpiry - Date.now()) / 1000) : null,
  });
});

app.get("/", (req, res) => {
  res.json({ service: "youpot", version: "1.0.0", endpoints: { token: "/api/token", health: "/health" }});
});

// ─── Self-Ping ──────────────────────────────────────────────────────────────
function startSelfPing() {
  const externalUrl = process.env.RAILWAY_PUBLIC_DOMAIN || process.env.RENDER_EXTERNAL_URL;
  if (!externalUrl) return;
  const protocol = externalUrl.startsWith("http") ? "" : "https://";
  const url = `${protocol}${externalUrl}/health`;
  setInterval(async () => {
    try { await fetch(url); } catch (_) {}
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
    try { await browser.close(); } catch (_) {}
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

start().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
