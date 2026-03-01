# pi-web

A web UI for the [pi coding agent](https://github.com/badlogic/pi-mono).

![pi-web screenshot](https://raw.githubusercontent.com/ravshansbox/pi-web/main/screenshot.png)

## Usage

```bash
npx -y pi-web@latest
```

Then open [http://127.0.0.1:8192](http://127.0.0.1:8192) in your browser.

For remote access, use the **recommended** Tailscale HTTPS setup below.

## Options

```
--port <number>      Port to listen on (default: 8192)
--host <string>      Host to bind to (default: 127.0.0.1)
--agent <pi|omp>     Agent backend profile (default: pi)
--help               Show help
```

To run against Oh My Pi, start with:

```bash
npx -y pi-web@latest --agent omp
```

## Recommended: secure access with Tailscale (HTTPS, no app password)

`pi-web` does not include built-in authentication. **Recommended setup:** keep it bound to `127.0.0.1` (IPv4 loopback) and expose it only through your private Tailnet.

1. Start `pi-web` locally (default host is already `127.0.0.1`):

```bash
npx -y pi-web@latest --host 127.0.0.1 --port 8192
```

2. In another terminal, expose it over Tailnet HTTPS using one of these bindings:

Without specifying an HTTPS port (default HTTPS binding):

```bash
tailscale serve --bg 8192
```

- Open in browser: `https://<your-device>.<your-tailnet>.ts.net/`

With an explicit HTTPS port binding (example: expose on Tailnet `8192`):

```bash
tailscale serve --bg --https=8192 http://127.0.0.1:8192
```

- Open in browser: `https://<your-device>.<your-tailnet>.ts.net:8192/`

- Prefer the explicit form when you want a non-default Tailnet HTTPS port, or when you want to avoid `localhost`/`::1` resolution ambiguity.

3. Check the HTTPS URL and serve status:

```bash
tailscale serve status
```

4. To stop exposing the service:

```bash
tailscale serve reset
```

Notes:

- This is accessible only to devices/users authorised in your Tailnet (and ACLs), so no separate `pi-web` password is required.
- Use `127.0.0.1` explicitly rather than `localhost` for `--host` and local proxy targets; on some systems `localhost` resolves to `::1` (IPv6), which can break loopback forwarding expectations.
- Avoid binding `pi-web` to `0.0.0.0` when using this setup.
- Do **not** use `tailscale funnel` unless you explicitly want public internet exposure.

## Features

- Browse and switch between pi sessions grouped by working directory
- Stream assistant responses in real time
- Collapsible tool call details with input/output
- Queue prompts while the agent is responding
- Switch provider and model from the status bar
- Mobile-friendly layout

## Development

```bash
git clone https://github.com/ravshansbox/pi-web
cd pi-web
npm install
npm run dev:pi   # Pi backend
npm run dev:omp  # Oh My Pi backend
```

Requires Node.js 22+.
