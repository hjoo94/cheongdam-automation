# Server Deploy Result

Deployment date: 2026-04-10

## Server

- Public IP: 43.201.84.136
- SSH user: ubuntu
- App path: /opt/chungdam-license-server
- Service name: chungdam-license-server
- Internal URL: http://127.0.0.1:4300
- Customer URL after Lightsail firewall opens: http://43.201.84.136:4300

## Completed

- SSH key permission fixed for local OpenSSH.
- License server code uploaded to `/opt/chungdam-license-server`.
- `.env` created on the server with `HOST=0.0.0.0`, `PORT=4300`, generated `ADMIN_SECRET`, and OpenAI API key from `ssh.txt`.
- `.env` permission set to `600`.
- `data/licenses.json` initialized.
- `npm install --omit=dev` completed.
- `systemd` service installed, enabled, and restarted.
- Local server health check passed: `http://127.0.0.1:4300/health`.
- Service state confirmed: `enabled` and `active`.

## External Access

Lightsail inbound `4300/tcp` was opened through the Lightsail API.

External health check passed:

```json
{"ok":true,"status":"healthy"}
```

The customer app and admin app server URL is:

```text
http://43.201.84.136:4300
```

## Admin Secret

The generated `ADMIN_SECRET` is stored locally in:

```text
C:\Users\DESKTOP\Desktop\코덱스\02_client_app\baemin-review-bot\.deploy\server.env
```

The same value is deployed on the server at:

```text
/opt/chungdam-license-server/.env
```
