# Shoarma DOM Probe — how to help fix the selectors in 3 minutes

The extension guesses where the chat input, Send button and reply bubbles are.
Your logs show Qwen's UI doesn't match those guesses (text lands in the box but
never gets "entered"). To fix it precisely, we need ONE dump of the real page
markup. Two ways — pick whichever is easier:

## Option A — Console snippet (no install)
1. Open a chat on https://chat.qwen.ai **and** https://chat.deepseek.com (one at a time).
2. Press F12 → the **Console** tab.
3. Paste the entire contents of `tools/shoarma-probe-console.js` and press Enter.
4. Wait ~3 seconds → the report prints + auto-copies to your clipboard (if allowed).
   If it didn't copy, run: `copy(window.__SHOARMA_PROBE__)`
5. Paste here. Done — repeat for the other site.

## Option B — Tampermonkey userscript
1. Install the "Tampermonkey" extension from the Chrome Web Store.
2. Tampermonkey dashboard → Utilities tab → "Import from file" → pick `tools/shoarma-probe.user.js`
   (or: Create a new script and paste the whole file).
3. Open a chat on each site, wait ~10 s, an alert pops up with the report; grab it via
   `copy(window.__SHOARMA_PROBE__)` in the console and paste it here.

⚠️ The probe only READS the page. It types nothing, clicks nothing, sends nothing
over the network except what you copy manually.

## What NOT to send instead
Full "Save page as → complete HTML" files are huge, mostly minified JS, and less
useful than the probe output. The probe gives exactly the three things we need:
input candidates, every visible button with its label/class/SVG-ness, and sample
message-bubble markup with role attributes.
