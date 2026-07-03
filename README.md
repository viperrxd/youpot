<div align="center">
  <h1>🎥 YouPOT Server</h1>
  <p><strong>Automatically generate fresh `poToken` and `visitorData` values for <a href="https://github.com/lavalink-devs/Lavalink">Lavalink</a> and the <a href="https://github.com/lavalink-devs/youtube-source">youtube-source</a> plugin.</strong></p>
  <p>Bypass YouTube's "Sign in to confirm you're not a bot" errors instantly.</p>
</div>

---

## ✨ Features

- **Web Interface:** Visit the page in your browser to instantly see fresh tokens you can copy/paste.
- **JSON API:** Grab tokens programmatically via `GET /api/token`.
- **Public Docker Image:** Anyone can easily run this via the pre-built image on GitHub Container Registry (GHCR).
- **Zero Config:** Just deploy it and it works. Powered by the reliable `youtube-po-token-generator`.

---

## 🚀 Getting Started

### Option 1: Docker (VPS / Local) - *Recommended*

This repository automatically builds and publishes a public Docker image to the GitHub Container Registry (`ghcr.io`) via GitHub Actions. Anyone can pull and run it instantly!

Create a `compose.yml` file on your server:

```yaml
services:
  youpot:
    image: ghcr.io/viperrxd/youpot:latest
    container_name: youpot
    restart: unless-stopped
    ports:
      - "8080:8080"
```
Then start it up:
```bash
docker compose up -d
```

### Option 2: Deploy to Railway or Pterodactyl

1. Push this repository to your GitHub account (`viperrxd/youpot`).
2. Deploy directly from your GitHub repo.
3. Your server will automatically run `npm install && node server.js`.

---

## 🎧 Lavalink Configuration

Once you generate your tokens from this server, add them to your [Lavalink](https://github.com/lavalink-devs/Lavalink) `application.yml` under the [youtube-source](https://github.com/lavalink-devs/youtube-source) plugin configuration:

```yaml
plugins:
  youtube:
    enabled: true
    # ... your other settings ...
    
    # Put your tokens here!
    pot:
      token: "YOUR_GENERATED_poToken_HERE"
      visitorData: "YOUR_GENERATED_visitorData_HERE"
```

---

## 📡 API Reference

| Method | Endpoint | Description |
|--------|------|-------------|
| `GET` | `/` | Returns a beautiful HTML page with your fresh tokens. |
| `GET` | `/api/token` | Returns the tokens in raw JSON format. |
| `GET` | `/health` | Server health check and uptime. |

---

## 🖥️ Manual Installation (For Developers)

```bash
# Install dependencies
npm install

# Start the server
node server.js

# Your server is now live at: http://localhost:8080
```
