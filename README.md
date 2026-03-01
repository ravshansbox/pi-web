# pi-web

A web UI for the [pi coding agent](https://github.com/badlogic/pi-mono).

![pi-web screenshot](https://raw.githubusercontent.com/ravshansbox/pi-web/main/screenshot.png)

## Usage

```bash
npx -y pi-web@latest
```

Then open [http://127.0.0.1:8192](http://127.0.0.1:8192) in your browser.

## Options

```
--port <number>      Port to listen on (default: 8192, env: PORT)
--host <string>      Host to bind to (default: 127.0.0.1, env: HOST)
--agent <pi|omp>     Agent backend profile (default: pi)
--help               Show help
```

To run against Oh My Pi, start with:

```bash
npx -y pi-web@latest --agent omp
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
npm run dev:pi   # Pi backend
npm run dev:omp  # Oh My Pi backend
```

Requires Node.js 22+.
