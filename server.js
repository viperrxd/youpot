const express = require('express');
const { generate } = require('youtube-po-token-generator');

const app = express();
const PORT = process.env.PORT || 8080;

const withTimeout = (promise, ms) => {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(`YouTube took too long to respond. The server IP might be temporarily blocked or rate-limited.`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
};

app.get('/', async (req, res) => {
    try {
        const tokens = await withTimeout(generate(), 20000); // 20 second timeout
        res.send(`
            <html>
                <head>
                    <title>YouTube PO Token Generator</title>
                    <style>
                        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f4f4f9; color: #333; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                        .container { background: #fff; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); max-width: 600px; width: 100%; text-align: center; }
                        h1 { color: #ff0000; }
                        .token-box { background: #eef2f5; padding: 1rem; border-radius: 4px; margin-top: 1rem; text-align: left; overflow-wrap: break-word; font-family: monospace; }
                        .label { font-weight: bold; color: #555; }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <h1>🎥 YouTube Tokens</h1>
                        <p>Fresh PO Token and Visitor Data generated successfully.</p>
                        <div class="token-box">
                            <p><span class="label">poToken:</span> <br/>${tokens.poToken}</p>
                            <p><span class="label">visitorData:</span> <br/>${tokens.visitorData}</p>
                        </div>
                        <p><small>Use these in your Lavalink application.yml config!</small></p>
                    </div>
                </body>
            </html>
        `);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: "Failed to generate tokens", 
            details: error.message 
        });
    }
});

app.get('/api/token', async (req, res) => {
    try {
        const tokens = await withTimeout(generate(), 20000);
        res.json(tokens);
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: "Failed to generate tokens",
            details: error.message
        });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: "ok", uptime: process.uptime() });
});

app.listen(PORT, () => {
    console.log(`[server] Listening on port ${PORT}`);
    console.log(`[server] Visit http://localhost:${PORT} to generate tokens!`);
});
