# Herdr AI Sessions (Ulanzi Studio Plugin)

Ulanzi Studio plugin for D200H / Ulanzi Deck devices to monitor live [Herdr](https://herdr.dev/) AI sessions and focus them directly in the Herdr app.

## Features

- Polls `hc ls --json` and `herdr-app ls` to display live session status (`NEEDS YOU`, `WORKING`, `DONE`, `ERROR`, `IDLE`), space name, tab/pane position (`Tab 1 / P1`), and agent/ID.
- Prioritizes sessions needing attention (`blocked` → `working` → `done` → `error` → `idle`).
- Pressing a key focuses the corresponding terminal in `herdr-app` and brings the Herdr window to the foreground on Windows.

## Requirements

- Windows 10/11
- [Ulanzi Studio](https://www.ulanzi.com/)
- [Node.js](https://nodejs.org/)
- [Herdr](https://herdr.dev/) (`hc` and `herdr-app` available in `PATH`)

## Installation on Another PC

1. Clone this repository into your Ulanzi Studio plugins directory:

```powershell
cd "$env:APPDATA\Ulanzi\UlanziDeck\Plugins"
git clone https://github.com/YoonSuhyeok/herdr-ulanzi-plugin.git com.herdr.sessions.ulanziPlugin
cd com.herdr.sessions.ulanziPlugin
npm install --omit=dev
```

2. Completely quit Ulanzi Studio (including the system tray icon) and relaunch it.
3. Drag **Herdr → AI Session Slot** onto your D200H keys.
