import {
	MarkdownPostProcessorContext,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
} from "obsidian";
import { PricePoint, alignRatio, olsWindow, rsiWilder, zScore } from "./math";

interface PriceRatioSettings {
	show200: boolean;
	show400: boolean;
	show1000: boolean;
	bandLevels: string; // comma list, e.g. "2" or "1,2"
	color200: string;
	color400: string;
	color1000: string;
	ratioColor: string;
	cacheHours: number;
}

const DEFAULT_SETTINGS: PriceRatioSettings = {
	show200: true,
	show400: true,
	show1000: true,
	bandLevels: "2",
	color200: "#e03131",
	color400: "#e8590c",
	color1000: "#2f9e44",
	ratioColor: "",
	cacheHours: 6,
};

interface CacheEntry {
	fetchedAt: number; // epoch ms
	points: PricePoint[];
}

interface PluginData {
	settings: PriceRatioSettings;
	cache: Record<string, CacheEntry>;
}

interface BlockOptions {
	top?: string;
	bottom?: string;
	windows?: number[]; // regression windows in trading days: 200, 400, 1000
	bands?: number[]; // SD levels
	asof?: string; // YYYY-MM-DD — draw the chart as if standing on this date
}

// Regression windows in trading days, matching Bloomberg's Multiperiod
// AutoReg template: the base "Period 200" stacked at 200 / 400 / 1,000
// days. Red is the 200-day, orange the 400-day, green the 1,000-day.
const WINDOW_DAYS = [200, 400, 1000];

// Visible chart range: five calendar years back from the last day (or all
// history if less) — the same span as Bloomberg's 5Y chart preset, which
// is also the rebase anchor, so levels line up with Bloomberg's. Each
// regression is fitted on its own trailing window and drawn only over
// that window, the way Bloomberg draws its channels.

const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-25" -> "Nov 25, 2026" (plain form for the header line). */
function plainDate(iso: string): string {
	const m = Number(iso.slice(5, 7));
	const d = Number(iso.slice(8, 10));
	return `${MONTH_ABBR[m - 1] ?? ""} ${d}, ${iso.slice(0, 4)}`;
}

function parseBlock(source: string): BlockOptions {
	const opts: BlockOptions = {};
	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const m = line.match(/^([A-Za-z]+)\s*:\s*(.+)$/);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const val = m[2].trim();
		if (key === "top" || key === "numerator") opts.top = val.toUpperCase();
		else if (key === "bottom" || key === "denominator") opts.bottom = val.toUpperCase();
		else if (key === "windows" || key === "days") {
			const days = val
				.split(/[,\s]+/)
				.map((s) => parseInt(s.replace(/d/i, ""), 10))
				.filter((n) => WINDOW_DAYS.includes(n));
			if (days.length) opts.windows = [...new Set(days)];
		} else if (key === "bands" || key === "band") {
			const lv = val
				.split(/[,\s]+/)
				.map((s) => parseFloat(s))
				.filter((n) => isFinite(n) && n > 0);
			if (lv.length) opts.bands = [...new Set(lv)];
		} else if (key === "asof") {
			opts.asof = val;
		}
	}
	return opts;
}

export default class PriceRatioChartPlugin extends Plugin {
	settings: PriceRatioSettings = { ...DEFAULT_SETTINGS };
	private cache: Record<string, CacheEntry> = {};

	async onload() {
		await this.loadDataAll();

		this.registerMarkdownCodeBlockProcessor("ratio", async (source, el, ctx) => {
			await this.renderBlock(source, el, ctx);
		});

		this.addSettingTab(new PriceRatioSettingTab(this));
	}

	onunload() {}

	private async loadDataAll() {
		const data = (await this.loadData()) as PluginData | null;
		if (data) {
			// Migrate the pre-1.1.0 setting names (1/2/3-year windows) to
			// the Bloomberg day-count windows, so saved choices carry over.
			const raw = (data.settings ?? {}) as unknown as Record<string, unknown>;
			const migrated: Record<string, unknown> = { ...raw };
			const carry = (oldKey: string, newKey: string) => {
				if (migrated[newKey] === undefined && raw[oldKey] !== undefined) {
					migrated[newKey] = raw[oldKey];
				}
			};
			carry("show1y", "show200");
			carry("show2y", "show400");
			carry("show3y", "show1000");
			carry("color1y", "color200");
			carry("color2y", "color400");
			carry("color3y", "color1000");
			this.settings = { ...DEFAULT_SETTINGS, ...(migrated as Partial<PriceRatioSettings>) };
			this.cache = data.cache ?? {};
		}
	}

	private async saveDataAll() {
		const data: PluginData = { settings: this.settings, cache: this.cache };
		await this.saveData(data);
	}

	async saveSettings() {
		await this.saveDataAll();
	}

	// ---------- data ----------

	private async fetchTicker(ticker: string): Promise<{ points: PricePoint[]; stale: boolean }> {
		const key = ticker.toUpperCase();
		const cached = this.cache[key];
		const maxAge = this.settings.cacheHours * 3600 * 1000;
		if (cached && Date.now() - cached.fetchedAt < maxAge) {
			return { points: cached.points, stale: false };
		}
		// Ten years of history, so an as-of date up to ~5 years back still
		// leaves a full five-year view behind it.
		const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
			key,
		)}?range=10y&interval=1d`;
		try {
			const resp = await requestUrl({
				url,
				headers: { "User-Agent": "Mozilla/5.0 (Obsidian Price Ratio Chart plugin)" },
			});
			const points = parseYahooChart(resp.json, key);
			if (!points.length) throw new Error("no price data returned");
			this.cache[key] = { fetchedAt: Date.now(), points };
			void this.saveDataAll();
			return { points, stale: false };
		} catch (e) {
			if (cached) return { points: cached.points, stale: true };
			throw new Error(
				`Could not get prices for ${key}. Check the ticker spelling and your connection.`,
			);
		}
	}

	// ---------- rendering ----------

	private async renderBlock(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
		const container = el.createDiv({ cls: "prc-container" });
		try {
			const opts = parseBlock(source);
			const top = opts.top?.toUpperCase();
			const bottom = opts.bottom?.toUpperCase();
			if (!top || !bottom) {
				throw new Error(
					"Both tickers must be named in the block — add top: and bottom: lines, like this: top: ORCL / bottom: QQQ",
				);
			}

			const [topData, bottomData] = [
				await this.fetchTicker(top),
				await this.fetchTicker(bottom),
			];
			const aligned = alignRatio(topData.points, bottomData.points);
			// Optional as-of date: draw the chart as if standing on that
			// date (a postmortem view). Everything — the visible window,
			// the regressions, RSI, the z-score, the header — is computed
			// on the truncated series, exactly as it would have looked then.
			let series = aligned;
			if (opts.asof) {
				const asof = opts.asof.trim();
				if (!/^\d{4}-\d{2}-\d{2}$/.test(asof)) {
					throw new Error(
						`Could not read the as-of date "${opts.asof}" — write it like this: asof: 2025-06-30`,
					);
				}
				// Last trading day on or before the as-of date.
				let cut = -1;
				for (let i = 0; i < aligned.dates.length; i++) {
					if (aligned.dates[i] <= asof) cut = i;
					else break;
				}
				if (cut < 0) {
					throw new Error(
						`No trading days on or before ${plainDate(asof)} for ${top} and ${bottom} — nothing to draw.`,
					);
				}
				if (cut + 1 < 60) {
					throw new Error(
						`Only ${cut + 1} trading days on or before ${plainDate(asof)} for ${top} and ${bottom} — not enough history to draw the chart (need at least 60).`,
					);
				}
				series = { dates: aligned.dates.slice(0, cut + 1), ratio: aligned.ratio.slice(0, cut + 1) };
			}
			if (series.ratio.length < 30) {
				throw new Error(
					`Only ${series.ratio.length} shared trading days for ${top} and ${bottom} — not enough to draw the chart.`,
				);
			}
			const stale = topData.stale || bottomData.stale;
			renderChart(container, this.settings, opts, top, bottom, series, stale);
		} catch (e) {
			container.empty();
			container.createDiv({
				cls: "prc-error",
				text: `Price Ratio Chart: ${e instanceof Error ? e.message : String(e)}`,
			});
		}
	}

}

function parseYahooChart(json: unknown, ticker: string): PricePoint[] {
	const result = (json as { chart?: { result?: unknown[] } })?.chart?.result?.[0] as
		| {
				timestamp?: number[];
				indicators?: { quote?: { close?: (number | null)[] }[] };
		  }
		| undefined;
	if (!result || !result.timestamp) {
		throw new Error(`Yahoo returned no data for ${ticker}. The ticker may be wrong.`);
	}
	const closes = result.indicators?.quote?.[0]?.close ?? [];
	const points: PricePoint[] = [];
	for (let i = 0; i < result.timestamp.length; i++) {
		const c = closes[i];
		if (c === null || c === undefined || !isFinite(c)) continue;
		const d = new Date(result.timestamp[i] * 1000);
		const date = d.toISOString().slice(0, 10);
		points.push({ date, close: c });
	}
	return points;
}

// ---------- SVG chart ----------

let clipSeq = 0;

function renderChart(
	container: HTMLElement,
	settings: PriceRatioSettings,
	opts: BlockOptions,
	top: string,
	bottom: string,
	aligned: { dates: string[]; ratio: number[] },
	stale: boolean,
) {
	const { dates, ratio } = aligned;
	const n = ratio.length;
	const lastDate = dates[n - 1];
	const lastRatio = ratio[n - 1];

	const bandLevels =
		opts.bands ??
		settings.bandLevels
			.split(/[,\s]+/)
			.map((s) => parseFloat(s))
			.filter((v) => isFinite(v) && v > 0);
	const windowStyles: Record<number, { show: boolean; color: string }> = {
		200: { show: settings.show200, color: settings.color200 },
		400: { show: settings.show400, color: settings.color400 },
		1000: { show: settings.show1000, color: settings.color1000 },
	};
	const activeWindows = (
		opts.windows ?? WINDOW_DAYS.filter((d) => windowStyles[d].show)
	).filter((d) => WINDOW_DAYS.includes(d));

	// First trading day on or after the date five calendar years before
	// the last day.
	const cutoff = `${Number(lastDate.slice(0, 4)) - 5}${lastDate.slice(4)}`;
	let viewStart = dates.findIndex((d) => d >= cutoff);
	if (viewStart < 0) viewStart = 0;
	// Rebase the plotted series to 100 on the first day of the visible
	// window, Bloomberg style: the chart shows relative strength, not the
	// raw ratio. The regressions are fitted on the rebased series — a pure
	// rescale of the raw fits (slopes and band widths scale by the same
	// factor) — while RSI and the z-score run on the raw ratio, which
	// rescaling would not change anyway. The header still prints the raw
	// ratio.
	const rebaseFactor = ratio[viewStart] > 0 ? 100 / ratio[viewStart] : 1;
	const rebased = ratio.map((v) => v * rebaseFactor);
	const view = rebased.slice(viewStart);

	const regressions = activeWindows.map((d) => ({
		days: d,
		res: olsWindow(rebased, d),
		color: windowStyles[d].color,
	}));

	// Z-score over 200 days, matching the shortest regression window
	// (Rob, 2026-11-27 — it was 250 before).
	const z = zScore(ratio, 200);
	const rsiSeries = rsiWilder(ratio, 14);
	const lastRsi = [...rsiSeries].reverse().find((v) => v !== null) ?? null;

	// Header line with the numbers.
	const header = container.createDiv({ cls: "prc-header" });
	const zText = `200-day z-score: ${z.z >= 0 ? "+" : ""}${z.z.toFixed(2)}`;
	const rsiText = lastRsi !== null ? `RSI(14): ${lastRsi.toFixed(1)}` : "RSI(14): —";
	header.createSpan({
		text: `${top} / ${bottom} — ratio ${lastRatio.toFixed(4)} · ${zText} · ${rsiText} · as of ${plainDate(lastDate)}${stale ? " · (cached data — could not refresh)" : ""}`,
	});
	const legend = container.createDiv({ cls: "prc-legend" });
	for (const r of regressions) {
		const item = legend.createSpan({ cls: "prc-legend-item" });
		item.createSpan({ cls: "prc-swatch", attr: { style: `background:${r.color}` } });
		item.createSpan({ text: `${r.days}-day` });
	}

	// Geometry.
	const W = 720;
	const mainTop = 8;
	const mainH = 280;
	const gap = 18;
	const rsiTop = mainTop + mainH + gap + 12;
	const rsiH = 84;
	const H = rsiTop + rsiH + 20;
	const padL = 6;
	const padR = 52;
	const plotW = W - padL - padR;

	// Each channel is drawn only over the window it was fitted on, like
	// Bloomberg: a channel's first day is the first day of its window.
	const winStart = (r: (typeof regressions)[number]) => n - r.res.window;
	// Fitted value of a regression at any point of its own window.
	const fitAt = (r: (typeof regressions)[number], globalIdx: number) =>
		r.res.startValue + r.res.slope * (globalIdx - winStart(r));

	// Y domain for the main panel: set by the price line alone. The axis
	// runs from zero up to a small margin (~3%) above the highest visible
	// price point. Regression lines and their bands do NOT stretch the
	// domain — Rob's call (2026-11-27): he doesn't need to see the tops of
	// the bands, so anything running above the axis top (or below the
	// zero floor — a price ratio can never be negative) is simply clipped
	// at the panel edge by the clip path further down.
	const peakPrice = Math.max(...view);
	const axisMin = 0;
	let axisMax = peakPrice * 1.03;
	if (!(axisMax > axisMin)) axisMax = axisMin + 0.01;

	// Regular y-axis intervals: a "nice" round step from the ladder,
	// chosen against the domain above and anchored at zero (0.05 / 0.1 /
	// 0.2 / 0.25 / 0.5 / ...), Bloomberg style. The domain itself is NOT
	// snapped out to a step multiple — labels are drawn only at ticks
	// that fall inside the axis range, so the topmost label can sit below
	// the panel top. Intervals stay perfectly regular. Labels only — no
	// gridlines.
	const NICE_STEPS = [
		0.001, 0.002, 0.0025, 0.005, 0.01, 0.02, 0.025, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50,
		100, 200, 250, 500, 1000,
	];
	let tickStep = NICE_STEPS[NICE_STEPS.length - 1];
	for (const s of NICE_STEPS) {
		if ((axisMax - axisMin) / s <= 6) {
			tickStep = s;
			break;
		}
	}
	const tickCount = Math.floor((axisMax - axisMin) / tickStep + 1e-9);
	const tickDecimals = (String(tickStep).split(".")[1] ?? "").length;

	const xFor = (globalIdx: number) => padL + ((globalIdx - viewStart) / (n - 1 - viewStart)) * plotW;
	const yFor = (v: number) => mainTop + (1 - (v - axisMin) / (axisMax - axisMin)) * mainH;
	const yRsi = (v: number) => rsiTop + (1 - v / 100) * rsiH;

	const svgNS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(svgNS, "svg");
	svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
	svg.setAttribute("class", "prc-svg");
	svg.setAttribute("width", "100%");
	container.appendChild(svg);

	const mk = (tag: string, attrs: Record<string, string | number>, parent: Element = svg) => {
		const node = document.createElementNS(svgNS, tag);
		for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
		parent.appendChild(node);
		return node;
	};
	const line = (
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		stroke: string,
		width: number,
		opacity = 1,
		dash = "",
		parent: Element = svg,
	) =>
		mk(
			"line",
			{
				x1,
				y1,
				x2,
				y2,
				stroke,
				"stroke-width": width,
				"stroke-opacity": opacity,
				...(dash ? { "stroke-dasharray": dash } : {}),
			},
			parent,
		);
	const text = (x: number, y: number, str: string, anchor = "start", cls = "prc-axis") => {
		const t = mk("text", { x, y, "text-anchor": anchor, class: cls });
		t.textContent = str;
		return t;
	};

	// Panel frames.
	mk("rect", { x: padL, y: mainTop, width: plotW, height: mainH, class: "prc-panel" });
	mk("rect", { x: padL, y: rsiTop, width: plotW, height: rsiH, class: "prc-panel" });

	// Everything drawn in the main panel goes into a group clipped to the
	// panel area, so band and regression lines that run below the zero floor
	// (or past any other edge) never spill outside the panel.
	const clipId = `prc-main-clip-${++clipSeq}`;
	const defs = mk("defs", {});
	const clipPathEl = document.createElementNS(svgNS, "clipPath");
	clipPathEl.setAttribute("id", clipId);
	const clipRect = document.createElementNS(svgNS, "rect");
	clipRect.setAttribute("x", String(padL));
	clipRect.setAttribute("y", String(mainTop));
	clipRect.setAttribute("width", String(plotW));
	clipRect.setAttribute("height", String(mainH));
	clipPathEl.appendChild(clipRect);
	defs.appendChild(clipPathEl);
	const mainGroup = mk("g", { "clip-path": `url(#${clipId})` });

	// Regression bands first (under everything else). Each channel spans
	// only its own fit window; the panel clip keeps anything below the
	// zero floor (or past an edge) inside the panel.
	for (const r of regressions) {
		const x1 = xFor(winStart(r));
		const x2 = xFor(n - 1);
		const v1 = fitAt(r, winStart(r));
		const v2 = fitAt(r, n - 1);
		for (const lvl of bandLevels) {
			for (const sgn of [1, -1]) {
				line(
					x1,
					yFor(v1 + sgn * lvl * r.res.residSd),
					x2,
					yFor(v2 + sgn * lvl * r.res.residSd),
					r.color,
					1,
					0.45,
					"",
					mainGroup,
				);
			}
		}
	}
	// Regression lines. No labels at the right edge — they overlapped the
	// y-axis tick numbers and cluttered the margin (Rob, 2026-11-27). The
	// legend line above the chart maps each color to its window instead,
	// so the right margin carries only the axis tick numbers.
	for (const r of regressions) {
		line(xFor(winStart(r)), yFor(fitAt(r, winStart(r))), xFor(n - 1), yFor(fitAt(r, n - 1)), r.color, 1.8, 1, "", mainGroup);
	}

	// Ratio line (rebased series).
	let d = "";
	for (let i = viewStart; i < n; i++) {
		d += `${i === viewStart ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(rebased[i]).toFixed(1)}`;
	}
	const ratioPath = mk("path", { d, fill: "none", "stroke-width": 1.4, class: "prc-ratio-line" }, mainGroup);
	if (settings.ratioColor) ratioPath.setAttribute("stroke", settings.ratioColor);

	// Y axis labels (right side): one at every regular tick. No gridlines.
	for (let i = 0; i <= tickCount; i++) {
		const v = axisMin + i * tickStep;
		text(W - padR + 4, yFor(v) + 3, v.toFixed(tickDecimals));
	}

	// X axis: a small tick mark at every month, but text labels only at
	// regular month intervals, Bloomberg style, with the year under each
	// December. Ticks and labels only — no vertical gridlines.
	const monthStarts: { idx: number; year: number; month: number }[] = [];
	let prevMonthKey = "";
	for (let i = viewStart; i < n; i++) {
		const key = dates[i].slice(0, 7);
		if (key !== prevMonthKey) {
			monthStarts.push({ idx: i, year: Number(dates[i].slice(0, 4)), month: Number(dates[i].slice(5, 7)) });
			prevMonthKey = key;
		}
	}
	// Month stride (1/2/3/6/12) chosen so the labels stay uncrowded; on a
	// five-year view this lands on 3 — Mar/Jun/Sep/Dec, like Bloomberg.
	let monthStride = 12;
	for (const s of [1, 2, 3, 6, 12]) {
		if (Math.ceil(monthStarts.length / s) <= 21) {
			monthStride = s;
			break;
		}
	}
	const monthLabelY = mainTop + mainH + 12;
	for (const ms of monthStarts) {
		// Tick mark at every month start.
		const tx = xFor(ms.idx);
		line(tx, mainTop + mainH, tx, mainTop + mainH + 4, "currentColor", 1, 0.45);
		// Text label only at the stride months.
		if (ms.month % monthStride !== 0) continue;
		const lx = Math.min(Math.max(tx, padL + 12), padL + plotW - 12);
		text(lx, monthLabelY, MONTH_ABBR[ms.month - 1], "middle");
		if (ms.month === 12) text(lx, monthLabelY + 11, String(ms.year), "middle");
	}

	// No in-chart z-score badge — the header line above the chart already
	// carries the z-score, and the badge duplicated it (Rob, 2026-11-27).

	// RSI panel: guide lines at 30/70 and the RSI line.
	for (const g of [30, 70]) {
		line(padL, yRsi(g), padL + plotW, yRsi(g), "currentColor", 0.7, 0.35, "3 3");
		text(W - padR + 4, yRsi(g) + 3, String(g));
	}
	text(padL + 6, rsiTop + 12, "RSI(14)", "start", "prc-tag");
	let rd = "";
	let started = false;
	for (let i = viewStart; i < n; i++) {
		const v = rsiSeries[i];
		if (v === null) continue;
		rd += `${!started ? "M" : "L"}${xFor(i).toFixed(1)},${yRsi(v).toFixed(1)}`;
		started = true;
	}
	if (rd) {
		const rp = mk("path", { d: rd, fill: "none", "stroke-width": 1.2, class: "prc-ratio-line" });
		if (settings.ratioColor) rp.setAttribute("stroke", settings.ratioColor);
	}
	if (lastRsi !== null) text(W - padR + 4, yRsi(lastRsi) + 3, lastRsi.toFixed(0));
}

// ---------- settings tab ----------

class PriceRatioSettingTab extends PluginSettingTab {
	constructor(private plugin: PriceRatioChartPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		new Setting(containerEl)
			.setName("Band levels")
			.setDesc('Standard deviation bands to draw, as a comma list. "2" draws just the two-SD bands; "1,2" draws both.')
			.addText((t) =>
				t.setValue(s.bandLevels).onChange(async (v) => {
					s.bandLevels = v.trim() || "2";
					save();
				}),
			);

		for (const [key, label] of [
			["show200", "Show 200-day regression (red)"],
			["show400", "Show 400-day regression (orange)"],
			["show1000", "Show 1,000-day regression (green)"],
		] as const) {
			new Setting(containerEl).setName(label).addToggle((t) =>
				t.setValue(s[key]).onChange(async (v) => {
					s[key] = v;
					save();
				}),
			);
		}

		for (const [key, label] of [
			["color200", "200-day line color"],
			["color400", "400-day line color"],
			["color1000", "1,000-day line color"],
		] as const) {
			new Setting(containerEl).setName(label).addText((t) =>
				t.setValue(s[key]).onChange(async (v) => {
					s[key] = v.trim() || s[key];
					save();
				}),
			);
		}

		new Setting(containerEl)
			.setName("Ratio line color")
			.setDesc("Leave blank to use the theme's normal text color.")
			.addText((t) =>
				t.setValue(s.ratioColor).onChange(async (v) => {
					s.ratioColor = v.trim();
					save();
				}),
			);

		new Setting(containerEl)
			.setName("Price cache (hours)")
			.setDesc("How long fetched prices are reused before refreshing. Cached prices also let notes open offline.")
			.addText((t) =>
				t.setValue(String(s.cacheHours)).onChange(async (v) => {
					const num = parseFloat(v);
					s.cacheHours = isFinite(num) && num >= 0 ? num : s.cacheHours;
					save();
				}),
			);
	}
}
