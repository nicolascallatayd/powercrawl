/**
 * Generic B2B Directory Scraper — Server entrypoint
 *
 * npm install
 * ANTHROPIC_API_KEY=sk-ant-... APP_PASSWORD=... node server.js
 * Then open http://localhost:3001
 */
import { createApp } from "./app.js";

const app = createApp();
const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`URL Extractor UI → http://localhost:${port}`));
