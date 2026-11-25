# ANESA CAMPUS OS — PRODUCTION DEPLOYMENT RUNBOOK
**Target Release**: `v1.0.0-rc.1`
**Target Environment**: Linux (Ubuntu 22.04 LTS / Debian 12 / Rocky Linux 9)
**Security Classification**: Production Infrastructure Standard Operating Procedure (SOP)

---

## 1. System Architecture & Resource Requirements

```mermaid
flowchart TD
    Internet([Internet / Campus Network]) --> Cloudflare[Reverse Proxy / WAF / TLS 1.3]
    Cloudflare --> Nginx[Nginx Ingress / Static Asset Host]
    Nginx -->|/assets, /index.html| WebDist[/opt/campusos/web/dist]
    Nginx -->|/api/*, /auth/*| FastifyCluster[Node.js 22 Fastify Cluster :4000]

    subgraph HostServer [Application Server Node]
        FastifyCluster --> ClamAVDaemon[ClamAV Daemon :3310]
        FastifyCluster --> S3Bucket[MinIO / AWS S3 Encrypted Bucket]
    end

    subgraph DataTier [Managed Database Tier]
        FastifyCluster --> PostgresPrimary[(PostgreSQL 16 Primary DB)]
        PostgresPrimary --> PostgresReplica[(PostgreSQL 16 Read Replica)]
    end
```

### Minimum Recommended Hardware Profile (Per 1,000 Concurrent Users)
- **Application Server (Web & API)**: 4 vCPU, 8 GB RAM, 50 GB NVMe SSD.
- **Database Server (PostgreSQL 16)**: 4 vCPU, 16 GB RAM, 100 GB NVMe SSD with automated WAL archiving.
- **Object Storage**: S3-compatible (AWS S3, Cloudflare R2, or MinIO) with server-side encryption (`AES256`).
- **Antivirus Service**: ClamAV daemon running locally or over private network.

---

## 2. Environment Variables & Secret Configuration

Create `/etc/campusos/production.env` with restricted permissions (`chmod 600`). See also [Secrets Runbook](../../runbooks/secrets.md) and [Credential Separation](../../runbooks/database-credential-separation.md).

```bash
# === NODE & SERVER ===
NODE_ENV=production
PORT=4000
HOST=127.0.0.1
LOG_LEVEL=info
APP_ORIGINS=https://portal.institution.edu

# === DATABASE CONNECTIONS ===
# Least-privilege runtime application user
DATABASE_URL=postgres://app_runtime:<SECURE_PASSWORD>@db.internal:5432/campusos_prod?sslmode=require
# Migration & provisioning superuser (used ONLY for running database migrations)
DATABASE_ADMIN_URL=postgres://app_owner:<SECURE_MIGRATION_PASSWORD>@db.internal:5432/campusos_prod?sslmode=require

# === CRYPTOGRAPHIC SECRETS (Generate with: openssl rand -base64 32) ===
SESSION_SECRET=<64_CHAR_HEX_OR_BASE64_SECRET>
CSRF_SECRET=<64_CHAR_HEX_OR_BASE64_SECRET>

# === USER MFA ENCRYPTION KEYS (format: key_id:base64_32_bytes) ===
MFA_ENCRYPTION_ACTIVE_KEY_ID=k1
MFA_ENCRYPTION_KEYS=k1:<BASE64_32_BYTE_KEY>

# === SCHOOL VAULT ZERO-ACCESS MASTER KEY ===
VAULT_MASTER_KEY=<64_CHAR_HEX_KEY>

# === DOCUMENT STORAGE (S3 COMPATIBLE) ===
STORAGE_DRIVER=s3
STORAGE_S3_ENDPOINT=https://s3.region.amazonaws.com
STORAGE_S3_REGION=ap-south-1
STORAGE_S3_BUCKET=campusos-institution-documents
STORAGE_S3_ACCESS_KEY=<IAM_ACCESS_KEY>
STORAGE_S3_SECRET_KEY=<IAM_SECRET_KEY>

# === CLAMAV ANTIVIRUS DAEMON ===
CLAMAV_HOST=127.0.0.1
CLAMAV_PORT=3310

# === EMAIL NOTIFICATIONS (SMTP) ===
SMTP_HOST=smtp.mailgun.org
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<SMTP_LOGIN>
SMTP_PASS=<SMTP_PASSWORD>
EMAIL_FROM="Anesa Campus OS Notifications <notifications@institution.edu>"
```

---

## 3. Step-by-Step Deployment Procedure

### Step 1: Database Initialization & Migrations
1. Verify database connectivity:
   ```bash
   psql "$DATABASE_ADMIN_URL" -c "SELECT version();"
   ```
2. Execute migration runner with migration lock:
   ```bash
   cd /opt/campusos/backend
   pnpm run migrate:up
   ```
3. Verify applied migrations catalog:
   ```bash
   psql "$DATABASE_ADMIN_URL" -c "SELECT id, name, applied_at FROM app.schema_migrations ORDER BY id DESC LIMIT 10;"
   ```

### Step 2: Application Build & Asset Placement
1. Build frontend distribution:
   ```bash
   cd /opt/campusos/apps/web
   pnpm run build
   # Assets placed in /opt/campusos/apps/web/dist
   ```
2. Compile backend distribution:
   ```bash
   cd /opt/campusos/backend
   pnpm run build
   # Compiled JavaScript placed in /opt/campusos/backend/dist
   ```

### Step 3: Nginx Reverse Proxy Configuration
Place the following in `/etc/nginx/sites-available/campusos.conf`:
```nginx
server {
    listen 80;
    server_name portal.institution.edu;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name portal.institution.edu;

    ssl_certificate /etc/letsencrypt/live/portal.institution.edu/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.institution.edu/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;

    # Security Headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https://portal.institution.edu;" always;

    # Static Web SPA
    root /opt/campusos/apps/web/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # API Proxy
    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 12M;
    }

    # Auth Proxy
    location /auth/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Step 4: Systemd Service Unit
Create `/etc/systemd/system/campusos-api.service`:
```ini
[Unit]
Description=Anesa Campus OS API Server
After=network.target postgresql.service clamav-daemon.service

[Service]
Type=simple
User=campusos
Group=campusos
WorkingDirectory=/opt/campusos/backend
EnvironmentFile=/etc/campusos/production.env
ExecStart=/usr/bin/node dist/server.js
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
```

Enable and start services:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now campusos-api
sudo systemctl status campusos-api
```

---

## 4. Post-Deployment Verification Checklist

1. **API Health Probe**:
   ```bash
   curl -s -i https://portal.institution.edu/api/v1/monitoring/health
   # Must return HTTP 200 with {"status":"HEALTHY", ...}
   ```
2. **TLS & HSTS Verification**:
   ```bash
   curl -s -I https://portal.institution.edu/ | grep -i strict-transport-security
   ```
3. **Database Runtime Role Least-Privilege Probe**:
   - Verify application connects strictly as `app_runtime`, not superuser.
4. **First Institution Creation via CLI**:
   ```bash
   pnpm --filter @campusos/backend exec tsx tools/platform/cli.ts tenant:create \
     --name "Demo Public School" \
     --slug "demo-school" \
     --institution-type SCHOOL \
     --admin-email "principal@demo-school.edu"
   ```
