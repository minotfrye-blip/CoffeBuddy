# Brew Buddy Backlog

## Open Bugs & Features

| ID | Type | Summary |
|----|------|---------|
| BB-005 | Feature | Drain timer with stopwatch logging |
| BB-006 | Feature | Persistent storage beyond localStorage |
| BB-010 | Bug/Prompt | Align prompts with Hoffmann on temp and steep time |
| BB-011 | Feature | AI-generated brew ratio |

---

### Detail

**BB-005 | Feature | Drain timer**
After the final 30s wait, offer "Drain & Done" or "Drain & Time It." The stopwatch result saves to the brew log and is passed to AI analysis as a grind calibration signal (fast drain = too coarse, slow = too fine).

**BB-006 | Feature | Persistent storage (beyond localStorage)**
Four options in increasing complexity: (1) Export/Import JSON -- no backend, just a safety net; (2) GitHub Gist as database -- free, requires OAuth; (3) Cloudflare KV -- fits existing Worker, needs user identity; (4) Cloudflare D1 -- full SQLite on Cloudflare, same catch. Decision needed on user identity strategy before 2-4 are viable.

**BB-010 | Bug/Prompt | Align prompts with Hoffmann on temp and steep time**
1. Lock `tempRec` to "just off boil (205-212F / 96-100C)" for all roast levels -- remove roast-level variation.
2. Reinforce 2.0 min as the steep default, deviating only for bean-specific reasons (e.g. very fresh high-CO2 beans).
Affects `buildRecipePrompt` and `buildBrewAnalysisPrompt` in `index.js`. Worker-only change.

**BB-011 | Feature | AI-generated brew ratio**
1. Add `ratio` output field to `buildRecipePrompt`, constrained to Hoffmann's 60-75g/L range (preference at lower end).
2. Replace hardcoded coffee doses with `Math.round(water / ratio)` -- always whole grams.
3. Display recommended ratio on recipe card alongside grind and steep time.
4. Wire `buildBrewAnalysisPrompt` to AI-generated ratio instead of hardcoded value.
Affects `index.js` and `index.html`.

---

## Closed

| ID | Type | Summary | Closed |
|----|------|---------|--------|
| BB-001 | Bug | Bean card grind setting stale after tasting note update | Mar 2026 |
| BB-002 | UX | Recipe card bleeds through timer overlay during strobe animation | Mar 2026 |
| BB-003 | Bug | Timer stops when user navigates away from tab | Mar 2026 |
| BB-004 | UX | Cancel brew shows native confirm -- should offer Save or Discard | Mar 2026 |
| BB-007 | Feature | Refine Worker prompts with Hoffmann methodology (superseded by BB-010 + BB-011) | Mar 2026 |

### Completed Features (pre-ID system)
- Worker security hardening -- CORS locked to GitHub Pages domain, shared client secret added
- Grind change callout + recipe last-updated date and reason
- Delete individual brew log entry
- Edit brew note and re-analyze from brew-time grind baseline
