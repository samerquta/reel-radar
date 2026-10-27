# REEL RADAR — Instructions for OpenAI Codex & AI Coding Agents

Created by **SAMER IBRAHIM** ([Facebook](https://www.facebook.com/samibra11/) | [Instagram @sam_ibra1](https://www.instagram.com/sam_ibra1)).

## Quick Launch Instructions (تشغيل النظام السريع)
When the user asks to start, run, or set up Reel Radar (e.g., "شغل النظام", "شغل المشروع", "run", "start"):

1. Ensure dependencies are installed:
   ```bash
   pnpm install || npm install
   ```
2. Start the local server on `http://127.0.0.1:3000`:
   ```bash
   pnpm dev
   ```
   *(Alternatively, execute `./start.sh` on macOS/Linux or `start.bat` on Windows).*
3. Inform the user that the Web UI is live at `http://127.0.0.1:3000` and they can paste their Apify API token (`apify_api_...`) directly via the **`Set Apify Key`** button in the top navigation bar or inside `apify-key.txt`.
