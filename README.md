# pi-web

A web UI for the [pi coding agent](https://github.com/badlogic/pi-mono).

![pi-web screenshot](https://raw.githubusercontent.com/ravshansbox/pi-web/main/screenshot.png)

## Usage

```bash
npx -y pi-web@latest
```

Then open [http://localhost:3100](http://localhost:3100) in your browser.

## Options

```
--port <number>   Port to listen on (default: 3100, env: PORT)
--host <string>   Host to bind to (default: localhost, env: HOST)
--help            Show help
```

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
npm run dev
```

Requires Node.js 22+.
