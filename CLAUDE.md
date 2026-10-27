# REEL RADAR — Instructions for Claude Code & AI Agents

Created by **SAMER IBRAHIM** ([Facebook](https://www.facebook.com/samibra11/) | [Instagram @sam_ibra1](https://www.instagram.com/sam_ibra1)).

## How to Run This System Immediately (تشغيل النظام)
When the user asks you to run, launch, or start this project (e.g., "شغل النظام", "شغل المشروع", "run", "start"):

1. **Install dependencies** (if `node_modules` is missing):
   ```bash
   pnpm install || npm install
   ```
2. **Start the Web Dashboard & API Server on Port 3000**:
   ```bash
   pnpm dev
   ```
   *(Or run `./start.sh` on macOS/Linux, `start.bat` on Windows).*
3. **Tell the user to open**:
   `http://127.0.0.1:3000`
4. **Apify API Key Setup**:
   - The user can set their Apify token (`apify_api_...`) directly in the Web UI by clicking the **`Set Apify Key`** button in the top header, OR by pasting it into `apify-key.txt` in the project root.

## Useful CLI Commands
- Discover Reels by hashtag/keyword: `pnpm cli discover --hashtag "ai,claude,chatgpt,motion" --max-posts 15`
- Collect Reels from an Instagram account: `pnpm cli collect --username <handle> --limit 15`
- Recompute viral outlier scores: `pnpm cli score`
- Run AI hook/topic analysis: `pnpm cli analyze --top 25`
- Generate the 5 Markdown/CSV reports in `./reports/`: `pnpm cli report --output ./reports`
