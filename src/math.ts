// Pure math for the Price Ratio Chart plugin.
// No Obsidian imports here, so the same code can be run under plain Node
// for the independent verification check (see scripts/check.mjs).

export interface PricePoint {
	date: string; // YYYY-MM-DD
	close: number;
}

export interface AlignedSeries {
	dates: string[];
	ratio: number[];
}

/** Divide two price series day by day, keeping only days both series have. */
export function alignRatio(top: PricePoint[], bottom: PricePoint[]): AlignedSeries {
	const bottomByDate = new Map<string, number>();
	for (const p of bottom) bottomByDate.set(p.date, p.close);
	const dates: string[] = [];
	const ratio: number[] = [];
	const sorted = [...top].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	for (const p of sorted) {
		const b = bottomByDate.get(p.date);
		if (b !== undefined && b !== 0 && p.close !== null && p.close !== undefined) {
			dates.push(p.date);
			ratio.push(p.close / b);
		}
	}
	return { dates, ratio };
}

export interface RegressionResult {
	window: number; // number of points actually used
	slope: number;
	intercept: number; // value at x = 0 (first day of the window)
	startValue: number; // fitted value on the first day of the window
	endValue: number; // fitted value on the last day of the window
	residSd: number; // population standard deviation of the residuals
}

/**
 * Ordinary least squares straight line over the last `window` values,
 * with x = 0..n-1 across the window. Residual SD uses the population
 * denominator (n), matching numpy's std default.
 */
export function olsWindow(values: number[], window: number): RegressionResult {
	const n = Math.min(window, values.length);
	const ys = values.slice(values.length - n);
	const xMean = (n - 1) / 2;
	let yMean = 0;
	for (const y of ys) yMean += y;
	yMean /= n;
	let sxy = 0;
	let sxx = 0;
	for (let i = 0; i < n; i++) {
		sxy += (i - xMean) * (ys[i] - yMean);
		sxx += (i - xMean) * (i - xMean);
	}
	const slope = sxx === 0 ? 0 : sxy / sxx;
	const intercept = yMean - slope * xMean;
	let ss = 0;
	for (let i = 0; i < n; i++) {
		const r = ys[i] - (intercept + slope * i);
		ss += r * r;
	}
	const residSd = Math.sqrt(ss / n);
	return {
		window: n,
		slope,
		intercept,
		startValue: intercept,
		endValue: intercept + slope * (n - 1),
		residSd,
	};
}

/**
 * Wilder RSI over the full series. Returns an array the same length as
 * `values`, with nulls before the first computable index (index = period).
 */
export function rsiWilder(values: number[], period = 14): (number | null)[] {
	const out: (number | null)[] = new Array(values.length).fill(null);
	if (values.length <= period) return out;
	let avgGain = 0;
	let avgLoss = 0;
	for (let i = 1; i <= period; i++) {
		const d = values[i] - values[i - 1];
		if (d > 0) avgGain += d;
		else avgLoss += -d;
	}
	avgGain /= period;
	avgLoss /= period;
	out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
	for (let i = period + 1; i < values.length; i++) {
		const d = values[i] - values[i - 1];
		const gain = d > 0 ? d : 0;
		const loss = d < 0 ? -d : 0;
		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;
		out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
	}
	return out;
}

export interface ZScoreResult {
	window: number;
	mean: number;
	sd: number; // population standard deviation
	z: number;
}

/** Z-score of the latest value against the last `window` values (population SD). */
export function zScore(values: number[], window = 250): ZScoreResult {
	const n = Math.min(window, values.length);
	const ys = values.slice(values.length - n);
	let mean = 0;
	for (const y of ys) mean += y;
	mean /= n;
	let ss = 0;
	for (const y of ys) ss += (y - mean) * (y - mean);
	const sd = Math.sqrt(ss / n);
	const last = values[values.length - 1];
	return { window: n, mean, sd, z: sd === 0 ? 0 : (last - mean) / sd };
}
