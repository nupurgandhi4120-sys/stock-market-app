(function () {
  "use strict";

  /** @typedef {{ name: string, symbol: string, kind: 'index' | 'stock' }} Instrument */

  /** @type {Instrument[]} */
  const INDICES = [
    { name: "Nifty 50", symbol: "^NSEI", kind: "index" },
    { name: "Sensex", symbol: "^BSESN", kind: "index" },
    { name: "Bank Nifty", symbol: "^NSEBANK", kind: "index" },
  ];

  /** @type {Instrument[]} */
  const STOCKS = [
    { name: "Reliance Ind.", symbol: "RELIANCE.NS", kind: "stock" },
    { name: "TCS", symbol: "TCS.NS", kind: "stock" },
    { name: "HDFC Bank", symbol: "HDFCBANK.NS", kind: "stock" },
    { name: "Infosys", symbol: "INFY.NS", kind: "stock" },
    { name: "ICICI Bank", symbol: "ICICIBANK.NS", kind: "stock" },
    { name: "Bharti Airtel", symbol: "BHARTIARTL.NS", kind: "stock" },
    { name: "SBI", symbol: "SBIN.NS", kind: "stock" },
    { name: "ITC", symbol: "ITC.NS", kind: "stock" },
    { name: "L&T", symbol: "LT.NS", kind: "stock" },
    { name: "Hind. Unilever", symbol: "HINDUNILVR.NS", kind: "stock" },
  ];

  const ALL_INSTRUMENTS = INDICES.concat(STOCKS);

  let currentSymbol = "RELIANCE.NS";
  let watchlistMap = /** @type {Record<string, object>} */ ({});
  let autoRefreshTimer = null;

  const CHART_RANGE = "3mo";
  const CHART_INTERVAL = "1d";
  const DISPLAY_BARS = 60;

  function chartUrl(symbol) {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=${CHART_INTERVAL}&range=${CHART_RANGE}`;
  }

  function miniChartUrl(symbol) {
    return `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      symbol
    )}?interval=1d&range=5d`;
  }

  /**
   * Build a quote-shaped object from Yahoo chart v8 (v7 /quote often returns 401 for browser clients).
   * @param {object} payload
   */
  function quoteFromChartPayload(payload) {
    const r = payload?.chart?.result?.[0];
    if (!r?.meta) return null;
    const m = r.meta;
    const price = m.regularMarketPrice;
    const prev = m.chartPreviousClose;
    if (price == null || prev == null) return null;
    const chg = price - prev;
    const pct = prev !== 0 ? (chg / prev) * 100 : 0;
    return {
      symbol: m.symbol,
      regularMarketPrice: price,
      regularMarketPreviousClose: prev,
      regularMarketChange: chg,
      regularMarketChangePercent: pct,
      regularMarketOpen: m.regularMarketOpen ?? null,
      regularMarketDayHigh: m.regularMarketDayHigh ?? null,
      regularMarketDayLow: m.regularMarketDayLow ?? null,
      regularMarketVolume: m.regularMarketVolume ?? null,
    };
  }

  const els = {
    chart: document.getElementById("chartContainer"),
    status: document.getElementById("dataStatus"),
    chartTitle: document.getElementById("chart-title"),
    chartLegend: document.getElementById("chartLegend"),
    qLast: document.getElementById("qLast"),
    qChange: document.getElementById("qChange"),
    qOpen: document.getElementById("qOpen"),
    qRange: document.getElementById("qRange"),
    qVol: document.getElementById("qVol"),
    signalText: document.getElementById("signalText"),
    signalDetail: document.getElementById("signalDetail"),
    indicatorList: document.getElementById("indicatorList"),
    btnRefresh: document.getElementById("btnRefresh"),
    wlIndices: document.getElementById("watchlistIndices"),
    wlStocks: document.getElementById("watchlistStocks"),
  };

  /** @type {import('lightweight-charts').IChartApi | null} */
  let chart = null;
  /** @type {import('lightweight-charts').ISeriesApi<'Candlestick'> | null} */
  let series = null;
  /** @type {import('lightweight-charts').ISeriesApi<'Histogram'> | null} */
  let volumeSeries = null;
  /** @type {import('lightweight-charts').ISeriesApi<'Line'> | null} */
  let ma10Series = null;
  /** @type {import('lightweight-charts').ISeriesApi<'Line'> | null} */
  let ma20Series = null;
  /** @type {import('lightweight-charts').ISeriesApi<'Line'> | null} */
  let ma50Series = null;

  function viaCorsProxyGet(url) {
    const enc = encodeURIComponent(url);
    return `https://api.allorigins.win/get?url=${enc}`;
  }

  async function fetchJson(url) {
    const local = await fetch("/api/yahoo?url=" + encodeURIComponent(url), {
      credentials: "omit",
    }).catch(() => null);
    if (local && local.ok) {
      return local.json();
    }
    const tryDirect = await fetch(url, { credentials: "omit" }).catch(() => null);
    if (tryDirect && tryDirect.ok) {
      return tryDirect.json();
    }
    const proxied = await fetch(viaCorsProxyGet(url), { credentials: "omit" });
    if (!proxied.ok) throw new Error("Proxy fetch failed");
    const wrapped = await proxied.json();
    const text = wrapped?.contents;
    if (typeof text !== "string") throw new Error("Bad proxy payload");
    return JSON.parse(text);
  }

  function isIndexSymbol(symbol) {
    return symbol.startsWith("^");
  }

  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function formatNumber(n, minFd, maxFd) {
    if (n == null || Number.isNaN(n)) return "—";
    return Number(n).toLocaleString("en-IN", {
      minimumFractionDigits: minFd,
      maximumFractionDigits: maxFd,
    });
  }

  function formatPrice(symbol, n) {
    if (n == null || Number.isNaN(n)) return "—";
    if (isIndexSymbol(symbol)) return formatNumber(n, 2, 2) + " pts";
    return "₹" + formatNumber(n, 2, 2);
  }

  function formatVol(n) {
    if (n == null || Number.isNaN(n)) return "—";
    if (n >= 1e7) return (n / 1e7).toFixed(2) + " Cr";
    if (n >= 1e5) return (n / 1e5).toFixed(2) + " L";
    return n.toLocaleString("en-IN");
  }

  function parseYahooCandles(payload) {
    const r = payload?.chart?.result?.[0];
    if (!r) throw new Error("No chart result");
    const q = r.indicators?.quote?.[0];
    const ts = r.timestamp;
    if (!q || !ts) throw new Error("Missing OHLC");
    const vols = q.volume || [];
    const out = [];
    for (let i = 0; i < ts.length; i++) {
      const t = ts[i];
      const o = q.open[i];
      const h = q.high[i];
      const l = q.low[i];
      const c = q.close[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.push({
        time: t,
        open: o,
        high: h,
        low: l,
        close: c,
        volume: vols[i] ?? null,
      });
    }
    return out;
  }

  function trimLastN(candles, n) {
    if (candles.length <= n) return candles;
    return candles.slice(-n);
  }

  function sma(values, period) {
    if (values.length < period) return null;
    let s = 0;
    for (let i = values.length - period; i < values.length; i++) s += values[i];
    return s / period;
  }

  function analyze(candles) {
    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2];
    const ma10 = sma(closes, 10);
    const ma20 = sma(closes, 20);
    const ma50 = sma(closes, Math.min(50, closes.length));
    const ret1d = prev != null ? ((last - prev) / prev) * 100 : null;

    let signal = "Neutral / mixed";
    let cls = "neutral";
    let detail =
      "Short and long averages are tight or conflicting. Wait for a clearer structure or use levels from recent swings.";

    if (ma20 != null && ma50 != null && last != null) {
      if (last > ma20 && ma20 > ma50 && (ret1d == null || ret1d >= 0)) {
        signal = "Trend bias: constructive";
        cls = "bull";
        detail =
          "Price is above the 20-day average and the 20-day is above the longer average — a simple uptrend template. Watch for weakness if price closes back under the 20-day average.";
      } else if (last < ma20 && ma20 < ma50 && (ret1d == null || ret1d <= 0)) {
        signal = "Trend bias: defensive";
        cls = "bear";
        detail =
          "Price is below the 20-day average with the 20-day under the longer average — a simple downtrend template. A sustained reclaim of the 20-day average would challenge this read.";
      }
    }

    return {
      last,
      ma10,
      ma20,
      ma50,
      ret1d,
      signal,
      signalClass: cls,
      detail,
    };
  }

  function renderAnalysis(a, symbol) {
    els.signalText.textContent = a.signal;
    els.signalText.className =
      "lead " + (a.signalClass === "bull" ? "bull" : a.signalClass === "bear" ? "bear" : "neutral");
    els.signalDetail.textContent = a.detail;

    const items = [];
    items.push(`Last close: ${formatPrice(symbol, a.last)}`);
    if (a.ret1d != null)
      items.push(`Prior session vs. previous: ${a.ret1d >= 0 ? "+" : ""}${a.ret1d.toFixed(2)}%`);
    if (a.ma10 != null) items.push(`10-day SMA: ${formatPrice(symbol, a.ma10)}`);
    if (a.ma20 != null) items.push(`20-day SMA: ${formatPrice(symbol, a.ma20)}`);
    if (a.ma50 != null) items.push(`Longer SMA (~50d or max available): ${formatPrice(symbol, a.ma50)}`);
    els.indicatorList.innerHTML = items.map((t) => `<li>${t}</li>`).join("");
  }

  function applyQuote(q, symbol) {
    const price = q.regularMarketPrice;
    const chg = q.regularMarketChange;
    const pct = q.regularMarketChangePercent;
    const open = q.regularMarketOpen;
    const low = q.regularMarketDayLow;
    const high = q.regularMarketDayHigh;
    const vol = q.regularMarketVolume;

    els.qLast.textContent = formatPrice(symbol, price);
    if (chg != null && pct != null) {
      const sign = chg >= 0 ? "+" : "";
      els.qChange.textContent = `${sign}${formatNumber(chg, 2, 2)} (${sign}${pct.toFixed(2)}%)`;
      els.qChange.className = chg >= 0 ? "up" : "down";
    } else {
      els.qChange.textContent = "—";
      els.qChange.className = "";
    }
    els.qOpen.textContent = formatPrice(symbol, open);
    if (low != null && high != null) els.qRange.textContent = `${formatPrice(symbol, low)} – ${formatPrice(symbol, high)}`;
    else els.qRange.textContent = "—";
    if (isIndexSymbol(symbol) && (vol == null || vol === 0)) {
      els.qVol.textContent = "—";
    } else {
      els.qVol.textContent = formatVol(vol);
    }
  }

  function ensureChart() {
    if (typeof LightweightCharts === "undefined") {
      els.chart.innerHTML =
        '<p style="padding:1rem;color:#9aa0ab">Chart library failed to load. Check your network and refresh.</p>';
      return null;
    }
    if (chart) return chart;
    chart = LightweightCharts.createChart(els.chart, {
      layout: {
        background: { type: "solid", color: "#16181f" },
        textColor: "#c4c7ce",
        fontFamily: 'system-ui, "Segoe UI", sans-serif',
      },
      grid: {
        vertLines: { color: "#2a2f3d" },
        horzLines: { color: "#2a2f3d" },
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a2f3d" },
      timeScale: {
        borderColor: "#2a2f3d",
        timeVisible: true,
        barSpacing: 12,
        rightOffset: 2,
      },
    });
    series = chart.addCandlestickSeries({
      upColor: "#26a69a",
      downColor: "#ef5350",
      borderVisible: true,
      borderUpColor: "#26a69a",
      borderDownColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
    });

    volumeSeries = chart.addHistogramSeries({
      priceScaleId: "",
      color: "rgba(91, 140, 255, 0.45)",
      priceFormat: { type: "volume" },
    });
    volumeSeries.priceScale().applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    ma10Series = chart.addLineSeries({
      color: "rgba(91, 140, 255, 0.9)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma20Series = chart.addLineSeries({
      color: "rgba(232, 196, 104, 0.95)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    ma50Series = chart.addLineSeries({
      color: "rgba(170, 160, 255, 0.9)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });

    chart.subscribeCrosshairMove((param) => {
      if (!els.chartLegend) return;
      if (!param || !param.time || !param.seriesData || !series) {
        els.chartLegend.textContent = "Hover the chart to see OHLC";
        return;
      }
      const c = param.seriesData.get(series);
      if (!c) {
        els.chartLegend.textContent = "Hover the chart to see OHLC";
        return;
      }
      const t = typeof param.time === "number" ? new Date(param.time * 1000) : null;
      const dateStr = t
        ? t.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "2-digit" })
        : String(param.time);
      const chg = c.close - c.open;
      const pct = c.open !== 0 ? (chg / c.open) * 100 : 0;
      const sign = chg >= 0 ? "+" : "";
      els.chartLegend.innerHTML =
        `<div><strong>${dateStr}</strong> <span class="muted">(${currentSymbol})</span></div>` +
        `<div class="muted">O ${formatPrice(currentSymbol, c.open)}  H ${formatPrice(currentSymbol, c.high)}  L ${formatPrice(currentSymbol, c.low)}  C ${formatPrice(currentSymbol, c.close)}</div>` +
        `<div class="muted">Move: ${sign}${formatNumber(chg, 2, 2)} (${sign}${pct.toFixed(2)}%)</div>`;
    });

    const ro = new ResizeObserver(() => {
      if (!chart || !els.chart) return;
      chart.applyOptions({
        width: els.chart.clientWidth,
        height: els.chart.clientHeight,
      });
    });
    ro.observe(els.chart);

    chart.applyOptions({
      width: els.chart.clientWidth,
      height: els.chart.clientHeight,
    });

    return chart;
  }

  function setCandles(candles) {
    const c = ensureChart();
    if (!c || !series) return;
    const data = candles.map((x) => ({
      time: x.time,
      open: x.open,
      high: x.high,
      low: x.low,
      close: x.close,
    }));
    series.setData(data);

    if (volumeSeries) {
      volumeSeries.setData(
        candles.map((x) => ({
          time: x.time,
          value: x.volume == null ? 0 : x.volume,
          color: x.close >= x.open ? "rgba(38, 166, 154, 0.45)" : "rgba(239, 83, 80, 0.45)",
        }))
      );
    }

    const closes = candles.map((x) => x.close);
    function lineFromSma(period) {
      const out = [];
      for (let i = 0; i < candles.length; i++) {
        if (i + 1 < period) continue;
        let s = 0;
        for (let j = i + 1 - period; j <= i; j++) s += closes[j];
        out.push({ time: candles[i].time, value: s / period });
      }
      return out;
    }
    if (ma10Series) ma10Series.setData(lineFromSma(10));
    if (ma20Series) ma20Series.setData(lineFromSma(20));
    if (ma50Series) ma50Series.setData(lineFromSma(Math.min(50, candles.length)));

    c.timeScale().fitContent();
  }

  function demoCandles(symbol) {
    const h = hashString(symbol);
    const isIndex = isIndexSymbol(symbol);
    let open = isIndex ? 21000 + (h % 8000) : 600 + (h % 2200);
    const start = Math.floor(Date.now() / 1000) - 86400 * 95;
    let d = start;
    const out = [];
    for (let i = 0; i < 70; i++) {
      d += 86400;
      const wd = new Date(d * 1000).getUTCDay();
      if (wd === 0 || wd === 6) continue;
      const drift = (Math.sin((i + (h % 17)) / 8) * 12 + ((h >> i) % 5) * 0.02 - 0.3) * (isIndex ? 2.5 : 1);
      const noise = ((h * (i + 3)) % 97) / 97 - 0.5;
      const close = Math.max(
        isIndex ? 15000 : 400,
        open + drift * (isIndex ? 35 : 10) + noise * (isIndex ? 40 : 18)
      );
      const high = Math.max(open, close) + Math.random() * (isIndex ? 55 : 18);
      const low = Math.min(open, close) - Math.random() * (isIndex ? 55 : 18);
      const t = Math.floor(d / 86400) * 86400;
      const volume = isIndex ? 0 : 5e6 + ((h * (i + 11)) % 6e6);
      out.push({ time: t, open, high, low, close, volume });
      open = close + (Math.random() - 0.5) * (isIndex ? 8 : 4);
    }
    return trimLastN(out, DISPLAY_BARS);
  }

  function setStatus(kind, text) {
    els.status.textContent = text;
    els.status.className = "live-pill " + (kind === "ok" ? "ok" : kind === "demo" ? "demo" : kind === "err" ? "err" : "");
  }

  function instrumentBySymbol(sym) {
    return ALL_INSTRUMENTS.find((i) => i.symbol === sym);
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateChartTitle(name, n, live) {
    const suffix = live ? " (last " + n + " days)" : " (demo — connect for live)";
    els.chartTitle.textContent = name + " — candlestick" + suffix;
  }

  function renderWatchlist() {
    function cardHtml(inst) {
      const q = watchlistMap[inst.symbol];
      let price = "—";
      let chgHtml = '<span class="wc-chg">—</span>';
      if (q) {
        const p = q.regularMarketPrice;
        price = formatPrice(inst.symbol, p);
        const chg = q.regularMarketChange;
        const pct = q.regularMarketChangePercent;
        if (chg != null && pct != null) {
          const sign = chg >= 0 ? "+" : "";
          const up = chg >= 0;
          chgHtml = `<span class="wc-chg ${up ? "up" : "down"}">${sign}${formatNumber(chg, 2, 2)} (${sign}${pct.toFixed(2)}%)</span>`;
        }
      }
      const active = inst.symbol === currentSymbol ? " is-active" : "";
      const dispName = escapeHtml(inst.name);
      return (
        `<button type="button" class="watch-card${active}" data-symbol="${inst.symbol}" role="listitem">` +
        `<span class="wc-name">${dispName}</span>` +
        `<span class="wc-sym">${inst.symbol}</span>` +
        `<span class="wc-price">${price}</span>` +
        chgHtml +
        `</button>`
      );
    }
    els.wlIndices.innerHTML = INDICES.map(cardHtml).join("");
    els.wlStocks.innerHTML = STOCKS.map(cardHtml).join("");
  }

  function setActiveWatchCards() {
    document.querySelectorAll(".watch-card").forEach((btn) => {
      const sym = btn.getAttribute("data-symbol");
      btn.classList.toggle("is-active", sym === currentSymbol);
    });
  }

  async function loadWatchlist() {
    watchlistMap = {};
    try {
      const payloads = await Promise.all(
        ALL_INSTRUMENTS.map((i) => fetchJson(miniChartUrl(i.symbol)).catch(() => null))
      );
      for (let i = 0; i < ALL_INSTRUMENTS.length; i++) {
        const sym = ALL_INSTRUMENTS[i].symbol;
        const pl = payloads[i];
        const q = pl ? quoteFromChartPayload(pl) : null;
        if (q) watchlistMap[sym] = q;
      }
      renderWatchlist();
      return true;
    } catch {
      renderWatchlist();
      return false;
    }
  }

  async function loadChart() {
    const inst = instrumentBySymbol(currentSymbol);
    const name = inst ? inst.name : currentSymbol;

    let candles = null;
    let quote = null;
    let live = false;

    try {
      const chartJ = await fetchJson(chartUrl(currentSymbol));
      candles = trimLastN(parseYahooCandles(chartJ), DISPLAY_BARS);
      quote = quoteFromChartPayload(chartJ);
      if (!quote) {
        const last = candles[candles.length - 1];
        const prev = candles[candles.length - 2];
        if (last && prev) {
          quote = {
            symbol: currentSymbol,
            regularMarketPrice: last.close,
            regularMarketPreviousClose: prev.close,
            regularMarketChange: last.close - prev.close,
            regularMarketChangePercent: ((last.close - prev.close) / prev.close) * 100,
            regularMarketOpen: last.open,
            regularMarketDayHigh: last.high,
            regularMarketDayLow: last.low,
            regularMarketVolume: null,
          };
        }
      }
      live = true;
      setStatus("ok", "Live data");
    } catch {
      candles = demoCandles(currentSymbol);
      const last = candles[candles.length - 1];
      quote = {
        regularMarketPrice: last.close,
        regularMarketPreviousClose: candles[candles.length - 2]?.close ?? last.close,
        regularMarketChange: last.close - (candles[candles.length - 2]?.close ?? last.close),
        regularMarketChangePercent:
          candles[candles.length - 2]?.close != null
            ? ((last.close - candles[candles.length - 2].close) / candles[candles.length - 2].close) * 100
            : 0,
        regularMarketOpen: last.open,
        regularMarketDayLow: last.low,
        regularMarketDayHigh: last.high,
        regularMarketVolume: isIndexSymbol(currentSymbol) ? null : 8e6 + Math.floor(Math.random() * 4e6),
      };
      setStatus("err", "Live feed unavailable. Retrying...");
    }

    setCandles(candles);
    if (quote) applyQuote(quote, currentSymbol);
    renderAnalysis(analyze(candles), currentSymbol);
    updateChartTitle(name, candles.length, live);
    setActiveWatchCards();
  }

  async function loadAll() {
    setStatus("", "Loading…");
    await loadWatchlist();
    await loadChart();
  }

  function startAutoRefresh() {
    if (autoRefreshTimer != null) clearInterval(autoRefreshTimer);
    autoRefreshTimer = setInterval(() => {
      loadAll();
    }, 15000);
  }

  function onWatchlistClick(e) {
    const btn = e.target.closest(".watch-card");
    if (!btn) return;
    const sym = btn.getAttribute("data-symbol");
    if (!sym || sym === currentSymbol) return;
    currentSymbol = sym;
    setActiveWatchCards();
    setStatus("", "Loading…");
    loadChart();
  }

  els.wlIndices.addEventListener("click", onWatchlistClick);
  els.wlStocks.addEventListener("click", onWatchlistClick);
  els.btnRefresh.addEventListener("click", loadAll);
  loadAll();
  startAutoRefresh();
})();
