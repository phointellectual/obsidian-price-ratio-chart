# Price Ratio Chart

Draw a live price-ratio chart inside any Obsidian note: one ticker's price divided by another's, with 200-, 400-, and 1,000-day regression lines and standard deviation bands, a 14-day RSI panel underneath, and the ratio's 200-day z-score printed on the chart.

Relative strength between two tickers is easier to read as a single ratio line than as two price charts. When the ratio drifts far from its own trend, the regression bands and the z-score give that "stretched" reading a number instead of an eyeball.

## What it draws

- The ratio line: the top ticker's daily close divided by the bottom ticker's daily close, on the days both traded, rebased to 100 on the first day of the chart — so the axis shows relative-strength levels, the way Bloomberg plots it. (The raw ratio is printed in the header.)
- A straight regression line fitted over each of the last 200, 400, and 1,000 trading days — the windows of Bloomberg's Multiperiod AutoReg template. Each channel is fitted on its own window and drawn only over that window, the way Bloomberg draws its channels. The 200-day line is red, the 400-day orange, and the 1,000-day green by default; colors are settings.
- Standard deviation bands around each regression line, at the levels you choose (two standard deviations by default; one, or both, are available). Band width is the standard deviation of the regression residuals.
- A lower panel with the 14-day RSI of the ratio (Wilder's method).
- The current ratio, the latest RSI, the 200-day z-score, and the as-of date (the last trading day in the data) in the header above the chart. The z-score says how many standard deviations today's ratio sits from its own average over the last 200 trading days.

## Using it in a note

Add a code block named `ratio` naming the two tickers, the one on top first:

    ```ratio
    top: ORCL
    bottom: QQQ
    ```

That draws Oracle divided by the QQQ ETF. Both tickers are always your choice, in every block — any stock, ETF, or index that Yahoo Finance carries.

Options, one per line inside the block:

- Both lines are required, every time. There are no default tickers — if either `top:` or `bottom:` is missing, the block shows a short message saying both tickers must be named, with an example, instead of a chart.
- `windows: 200,1000` — draw only the regression windows listed (any of 200, 400, 1,000 days).
- `bands: 1,2` — draw the bands at those standard deviation levels instead of the default.
- `asof: 2025-06-30` — draw the chart as if standing on that date: the visible window, the regressions, the RSI, the z-score, and the header values are all computed from data up to the last trading day on or before it. Useful for postmortems — checking whether the chart would have supported the same decision at the time. Omit it for today's chart.

If a ticker is misspelled, or there is no connection and no cached prices yet, the block shows a plain error message instead of a chart.

## Settings

Under Settings → Community plugins → Price Ratio Chart:

- **Band levels** — which standard deviation bands to draw, as a comma list. `2` draws just the two-standard-deviation bands; `1,2` draws both.
- **Show 200/400/1,000-day regression** — three switches to turn each window's line and bands on or off.
- **Line colors** — the color for each regression window, and one for the ratio line itself (blank means it follows your theme's text color).
- **Price cache (hours)** — how long fetched prices are reused before the plugin fetches fresh ones. Starts at 6 hours.

## Network use and privacy

This plugin uses the network for one thing only: downloading daily closing prices from Yahoo Finance (`query1.finance.yahoo.com`) when a note containing a `ratio` block is opened and the cached prices are older than the cache setting. Downloaded prices are cached in the plugin's own data file inside your vault, so notes still open offline and Yahoo is not asked again until the cache expires.

The plugin has no accounts, no telemetry, and no analytics. It sends nothing anywhere except the ticker symbols in the price request itself. It does not read or modify your notes; it only renders the chart inside them.

## Installing

**From the community directory** (once listed): Settings → Community plugins → turn off Restricted Mode if prompted → Browse → search for "Price Ratio Chart" → Install → Enable.

**With BRAT** (works before any directory listing, and keeps the plugin updated from GitHub releases):

1. Install and enable the BRAT plugin from Settings → Community plugins → Browse.
2. Open the command palette and run "BRAT: Add a beta plugin for testing".
3. Paste this repository's address (`owner/repo` or the full GitHub URL) and click "Add Plugin".
4. Go back to Settings → Community plugins, refresh the list if needed, and enable Price Ratio Chart.

**Manually:** download `main.js`, `manifest.json`, and `styles.css` from the latest GitHub release, put them in a folder named `price-ratio-chart` inside your vault's `.obsidian/plugins/` folder, restart Obsidian, and enable Price Ratio Chart under Settings → Community plugins.

## Building from source

```
npm install
npm run build
```

That type-checks the TypeScript and bundles `src/main.ts` into `main.js` with esbuild.

## License

MIT. See [LICENSE](LICENSE).
