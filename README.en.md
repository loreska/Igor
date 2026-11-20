# Igor · It Goes On Reading

[Italian README](README.md) · [Open Igor](https://igor.lorelive.org/)

Igor is a browser-based teleprompter by Lorenzo Mosna / Lorelive. Igor, played by Marty Feldman in Mel Brooks’s Young Frankenstein, has one of the most famous humps in film history. In Italian, gobbo means “hunchback.” It was also the nickname for the prompter who crouched beneath the camera, holding up cue cards. Today, it’s what Italians call a teleprompter.

I built Igor to solve a problem I often run into when filming solo. From behind the camera, it’s hard to see what’s on the teleprompter. Igor mirrors the teleprompter display on my phone, so I can see exactly what the person in front of the camera is reading while I keep filming.

## Start reading

1. On a phone or PC, type or paste a script, or upload a TXT, DOCX or PDF with selectable text under **Script**.
2. For a separate tablet or monitor, select **Pair display**. On the tablet, open **Display mode** and enter the five-character code or scan the QR code. The code lasts five minutes and can be used once. Reconnecting the same tab uses its existing session.
3. Select **Open teleprompter** on the control device. Play, pause, adjust the scroll speed or font size, and move through the script or slides. Use **Back to materials** to change files and mirroring.
4. You can also select **Read on this device** for a one-device setup. Tap once to play or pause, drag to scroll, or double-tap to open reading options.

Use **Language** on the home or pairing screen to choose Italian, English or **Automatic**. Automatic checks the browser’s preferred languages and falls back to English. The selection is stored separately on each device and changing it reloads the page. Add `?lang=en` or `?lang=it` to share an explicit language. Scripts and documents keep their original language.

## Files, controls and recovery

- DOCX keeps structural formatting such as headings, bold, italics and lists. Turn off **Keep Word formatting** to use plain text.
- Use **Slides** for PDF presentations or PowerPoint. Scanned PDFs can be shown as pages. Text extraction requires selectable text.
- The first PowerPoint conversion may download about 248 MB of browser resources. The converter runs on the device and supports PPTX files up to 40 MB. Select **Slides + notes** or **Notes only** to read speaker notes. Use a PDF export when exact rendering is important.
- Keyboard or compatible Bluetooth remote: Space plays or pauses, Up and Down scroll, Left/Right and Page Up/Page Down change slides, and +/− adjust speed.
- **Configure remote** shows input from a keyboard, pedal or gamepad. Choose **Script** or **Slides**, choose an action and select **Press a key to map it**. Mappings are stored in the browser. In Script mode, a stick axis can scroll proportionally.
- With a Web Bluetooth browser, tap **Reading options** five times to reveal **Connect Moman** below **Mirroring**. In display mode, double-tap first to open the reading options. With a Moman 2A32, move the stick vertically to scroll. Y/A adjust speed or change slides, X/B change text size, OK plays or pauses, and ON/OFF returns to the beginning. Disconnect other apps from the remote first.
- **Resume last session** and **Recent projects** recover work saved in the same browser and origin. Igor keeps up to five recent projects and resumes them paused. Pair the tablet again if the control tab was reloaded.
- Tap the logo once for credits. Tap three times quickly to play **WHEREPROMTER? THEREPROMPTER!**. The game runs in the browser and can use the current script as its background.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
npm start
npm test
```

Open `http://127.0.0.1:8787/`. Run the test command separately from the development server. The suite checks the converter assets, playback and relay limits, and simulates 300 WebSocket pairs locally. Try two devices on the same Wi-Fi and check **Direct** under connection status, then try separate networks to check **Server relay**.

`server.cjs` serves the page and static assets, `relay.cjs` handles pairing and relay traffic, and `public/` contains the interface. To add a language, extend the dictionaries in `public/i18n.js` and the language pickers in `public/index.html`. Use the Italian source string as the key. Machine translation can produce a first draft. Review command labels, broadcast terms, accessibility labels, plurals and placeholders in the running app.

## VPS deployment

Copy the source files to the VPS, keeping local `.env` and Caddy configuration. Use the same Compose files as your existing container. For the Caddy-network setup:

```sh
cd /opt/igor
docker compose -f compose.yaml -f compose.caddy.yaml config -q
docker compose -f compose.yaml -f compose.caddy.yaml build
docker compose -f compose.yaml -f compose.caddy.yaml up -d --no-build
curl -fsS https://igor.lorelive.org/healthz
```

If the existing installation uses only `compose.yaml`, omit the Caddy overlay from those commands. With the overlay, `CADDY_NETWORK` must identify the Docker network shared with Caddy. HTTPS and the server’s COOP/COEP headers are needed for PowerPoint conversion outside localhost. Deploy when the teleprompter is idle because restarting clears active pairings. The Italian README includes the ZIP transfer and backup commands.

### Resource limits

Igor attempts direct WebRTC, using local candidates, and falls back to a WebSocket relay. The container defaults to 100 MiB and admits up to 300 sessions. These settings are configurable through `IGOR_MEMORY_LIMIT` and `IGOR_MAX_SESSIONS`. Actual capacity depends on usage and VPS resources. Caddy is measured separately. The VPS streams the converter assets and relays active views and commands when a direct connection is unavailable.

- `IGOR_IP_SESSIONS` and `IGOR_IP_SOCKETS` limit use per IP address. A value of 0 disables the corresponding per-IP limit. Devices on one network may share a public IP. Invalid pairing attempts are also rate-limited.
- `/healthz` reports session and connection counts and process memory. Use `docker stats` to check container memory and the proxy separately. Linux may count cached converter data in container memory.
- Caddy can compress public assets with `encode zstd gzip`.
- Use `node test/load.cjs 1000 https://your-domain/igor 30` only against a test instance with the matching session cap and test-appropriate IP limits.
