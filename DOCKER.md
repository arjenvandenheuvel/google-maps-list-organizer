# Docker Setup

Run Google Maps List Organizer remotely via Docker with a web interface.

## Prerequisites

- Docker and Docker Compose on your server
- VPN access to your home network

## Quick Start (Pre-built Image)

Use the pre-built image from GitHub Container Registry:

### 1. Create project directory on your server

```bash
mkdir -p ~/maps-organizer && cd ~/maps-organizer
```

### 2. Create docker-compose.yml

```yaml
services:
  maps-organizer:
    image: ghcr.io/arjenvandenheuvel/google-maps-list-organizer:latest
    container_name: maps-organizer
    ports:
      - "6080:6080"
      - "3001:3001"
    volumes:
      - chrome-data:/chrome-data
      - ./tmp:/app/tmp
      - ./blackhole:/app/blackhole
      - ./master-locations.json:/app/master-locations.json
    environment:
      - API_TOKEN=${API_TOKEN:-changeme}
      - DISPLAY=:99
    restart: unless-stopped

volumes:
  chrome-data:
```

### 3. Set up environment and start

```bash
# Generate a secure token
echo "API_TOKEN=$(openssl rand -hex 24)" > .env
cat .env  # Save this token!

# Create required files
mkdir -p tmp blackhole
echo "[]" > master-locations.json

# Start
docker compose up -d
```

## Alternative: Build Locally

If you prefer to build the image yourself:

### 1. Copy files to your server

```bash
scp -r . yourserver:~/maps-organizer/
```

### 2. Set up environment

```bash
cd ~/maps-organizer
cp .env.example .env

# Generate a secure token
echo "API_TOKEN=$(openssl rand -hex 24)" > .env
cat .env  # Save this token for later!
```

### 3. Build and start

```bash
docker compose up -d --build
```

### 4. Log into Google (one-time setup)

1. Open noVNC in your browser: `http://your-server:6080/vnc.html`
2. Chrome is running - navigate to `https://maps.google.com`
3. Log in to your Google account
4. Verify your saved lists appear

### 5. Use the web interface

Open `http://your-server:3001/` in your browser.

Enter your API token when prompted (from step 2).

## Ports

| Port | Service |
|------|---------|
| 3001 | Web API + Dashboard |
| 6080 | noVNC (Chrome access) |

## API Endpoints

All endpoints require `Authorization: Bearer YOUR_TOKEN` header.

```bash
# Get status
curl -H "Authorization: Bearer $TOKEN" http://server:3001/status

# Run extract
curl -X POST -H "Authorization: Bearer $TOKEN" http://server:3001/extract

# Run move (with options)
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "dryRun": true}' \
  http://server:3001/move

# Stop running job
curl -X POST -H "Authorization: Bearer $TOKEN" http://server:3001/stop

# Reset progress
curl -X POST -H "Authorization: Bearer $TOKEN" http://server:3001/reset

# Add places from blackhole
curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit": 10, "dryRun": true, "force": false}' \
  http://server:3001/add
```

## Changing Config

Edit `src/config.ts` before building, or mount it as a volume:

```yaml
volumes:
  - ./src/config.ts:/app/src/config.ts:ro
```

Then restart the container to pick up changes.

## Troubleshooting

### Chrome won't connect

Check if Chrome is running:
```bash
docker compose logs maps-organizer | grep chrome
```

### Google session expired

Open noVNC (`http://server:6080/vnc.html`) and re-login to Google.

### View logs

```bash
docker compose logs -f maps-organizer
```

## Blackhole (Add New Places)

Drop JSON files into the `blackhole/` folder to add new places to your Google Maps lists.

**JSON format:**
```json
{
  "locations": [
    {
      "id": "unique-id",
      "name": "Place Name",
      "lat": 35.6762,
      "lng": 139.6503,
      "list": "Tokyo WTG"
    }
  ]
}
```

**How it works:**
1. Drop a `.json` file into `blackhole/`
2. Click "Add from Blackhole" in the dashboard (or call `/add` API)
3. Each location is added to the specified list
4. Deduplication via `master-locations.json` prevents re-adding

**Remote file drop:** Copy files via SCP:
```bash
scp trip-locations.json yourserver:~/maps-organizer/blackhole/
```

## Data Persistence

- **Chrome profile**: Stored in `chrome-data` Docker volume (persists login)
- **tmp/ data**: Mounted from host, persists places.json, progress, etc.
- **blackhole/**: Inbox for JSON files to add
- **master-locations.json**: Tracks all added locations (dedup across files)

## Security Notes

- Change the default API token!
- Consider adding HTTPS via reverse proxy (nginx, Caddy)
- noVNC has no password by default - restrict network access or add VNC password
