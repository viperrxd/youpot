const express = require("express");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;

let cachedTokens = null;
let isFetching = false;
let browser = null;

async function launchBrowser() {
  if (browser) return;
  console.log("[browser] Launching headless Chromium with Stealth mode...");
  browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--no-zygote",
      "--mute-audio"
    ],
  });
  console.log("[browser] Chromium launched successfully.");
}

async function fetchTokens() {
  if (isFetching) {
    while (isFetching) {
      await new Promise((r) => setTimeout(r, 500));
    }
    return cachedTokens;
  }

  isFetching = true;
  let page = null;

  try {
    console.log("[token] Starting fresh token fetch process...");
    await launchBrowser();
    page = await browser.newPage();
    
    // Speed optimization: Block unnecessary assets
    await page.setRequestInterception(true);
    
    const tokenPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Token fetch timed out. YouTube might be heavily throttling."));
      }, 45000);

      page.on("request", (req) => {
        const url = req.url();
        const resourceType = req.resourceType();

        // --- THE MAGIC INTERCEPTOR ---
        
        // 1. Check URL parameters (e.g. timedtext, videoplayback)
        try {
          const urlObj = new URL(url);
          const potParam = urlObj.searchParams.get("pot");
          if (potParam) {
            console.log(`[token] SUCCESS! Found 'pot' parameter in URL: ${urlObj.pathname}`);
            page.evaluate(() => window.ytcfg?.data_?.VISITOR_DATA).then((vData) => {
              if (vData) {
                clearTimeout(timeout);
                resolve({ poToken: potParam, visitorData: vData });
              }
            }).catch(() => {});
          }
        } catch (_) {}

        // 2. Check POST payloads (e.g. /youtubei/v1/player)
        if (url.includes("/youtubei/v1/") && req.method() === "POST") {
          try {
            const postData = req.postData();
            if (postData) {
              const body = JSON.parse(postData);
              const poToken = body?.serviceIntegrityDimensions?.poToken;
              const visitorData = body?.context?.client?.visitorData;

              if (poToken && visitorData) {
                clearTimeout(timeout);
                console.log("[token] SUCCESS! Extracted tokens from POST payload.");
                resolve({ poToken, visitorData });
              }
            }
          } catch (_) {}
        }
        
        req.continue();
      });
    });

    console.log("[token] Navigating to YouTube Embed page (Bypassing 429 IP Block)...");
    
    // Set a Referer header! Opening embeds directly without a referer often causes Error 153
    await page.setExtraHTTPHeaders({
      'Referer': 'https://www.google.com/'
    });

    // We use the Embed URL for "Me at the zoo" (jNQXAC9IVRw) 
    // Embeds avoid the 429 CAPTCHA block applied to datacenter IPs!
    await page.goto("https://www.youtube.com/embed/jNQXAC9IVRw?autoplay=1", {
      waitUntil: "domcontentloaded",
      timeout: 40000,
    });

    console.log("[token] Embed page loaded. Forcing playback to trigger BotGuard...");

    // BotGuard requires the video to actually play. Let's force it.
    try {
      await page.waitForSelector(".ytp-large-play-button", { timeout: 8000 });
      await page.click(".ytp-large-play-button");
      console.log("[token] Clicked the large play button.");
    } catch (err) {
      console.log("[token] Play button missing. Executing fallback spacebar/click...");
      await page.keyboard.press("Space");
      await page.mouse.click(200, 200);
    }

    console.log("[token] Waiting for background network requests...");
    const tokens = await tokenPromise;
    
    cachedTokens = tokens;
    console.log("[token] Tokens cached successfully!");
    
    return tokens;

  } catch (error) {
    console.error(`[error] Failed to fetch tokens: ${error.message}`);
    throw error;
  } finally {
    isFetching = false;
    if (page) await page.close().catch(() => {});
  }
}

// Serve the beautiful UI dashboard
app.use(express.static("public"));

app.get("/api/token", async (req, res) => {
  console.log(`[server] Received token request from ${req.ip}`);
  try {
    const tokens = await fetchTokens();
    res.json(tokens);
  } catch (error) {
    res.status(500).json({ error: "Failed to generate tokens", message: error.message });
  }
});

// Endpoint to validate if the current tokens are actually working on YouTube
app.get("/api/validate", async (req, res) => {
  console.log(`[server] Validating tokens against YouTube API...`);
  try {
    const tokens = await fetchTokens();
    const ytPayload = {
      context: {
        client: {
          hl: "en", gl: "US",
          clientName: "WEB",
          clientVersion: "2.20240101.00.00",
          visitorData: tokens.visitorData
        }
      },
      videoId: "4NRXx6U8ABQ", // Blinding Lights
      playbackContext: { contentPlaybackContext: { signatureTimestamp: 19800 } },
      serviceIntegrityDimensions: { poToken: tokens.poToken }
    };

    const ytResponse = await fetch("https://www.youtube.com/youtubei/v1/player", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(ytPayload)
    });

    const ytData = await ytResponse.json();
    const playability = ytData.playabilityStatus?.status;

    if (playability === "OK" && ytData.streamingData) {
      res.json({ valid: true, formats: ytData.streamingData.adaptiveFormats?.length || 0 });
    } else {
      res.json({ valid: false, reason: ytData.playabilityStatus?.reason || "Blocked" });
    }
  } catch (error) {
    res.status(500).json({ valid: false, reason: error.message });
  }
});

app.listen(PORT, async () => {
  console.log(`[server] Listening on port ${PORT}`);
  console.log(`[server] Token endpoint: http://localhost:${PORT}/api/token`);
  // Pre-launch browser so it's warm
  await launchBrowser();
});
