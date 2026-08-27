require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const APP_VERSION = "13.1";
const API_KEY = String(process.env.TWELVE_DATA_API_KEY || "").trim();
const SYMBOL = String(process.env.XAU_SYMBOL || "XAU/USD").trim();
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/stream" });

app.disable("x-powered-by");
app.use(express.static("public", { extensions: ["html"] }));

// Historical-data cache + fallback. The live price stream is intentionally kept
// independent from historical candles so a Twelve Data daily quota cannot blank
// the chart. Cache is process-local; the browser also keeps its own candle cache.
const historyCache = new Map();
const HISTORY_TTL_MS = 5 * 60 * 1000;

const yahooRange = {
  "1min": "1d",
  "5min": "5d",
  "15min": "1mo",
  "1h": "1mo"
};
const yahooInterval = { "1min": "1m", "5min": "5m", "15min": "15m", "1h": "1h" };

async function fetchYahooHistory(interval, outputsize) {
  const range = yahooRange[interval] || "1d";
  const yInterval = yahooInterval[interval] || "1m";
  const url = new URL("https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X");
  url.searchParams.set("range", range);
  url.searchParams.set("interval", yInterval);
  url.searchParams.set("includePrePost", "true");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json", "user-agent": "Mozilla/5.0" } });
    if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
    const data = await response.json();
    const result = data?.chart?.result?.[0];
    const timestamps = result?.timestamp || [];
    const q = result?.indicators?.quote?.[0] || {};
    const values = [];
    for (let i = 0; i < timestamps.length; i++) {
      const open = Number(q.open?.[i]), high = Number(q.high?.[i]), low = Number(q.low?.[i]), close = Number(q.close?.[i]);
      if ([open, high, low, close].every(Number.isFinite)) {
        values.push({ datetime: new Date(timestamps[i] * 1000).toISOString(), open, high, low, close });
      }
    }
    if (values.length < 2) throw new Error("Yahoo Finance hat keine ausreichenden XAU/USD-Kerzen geliefert.");
    return values.slice(-Math.max(60, Math.min(Number(outputsize) || 180, 500)));
  } finally { clearTimeout(timer); }
}

function jsonError(res, status, message, extra = {}) {
  res.status(status).json({ status: "error", message, ...extra });
}

async function td(path, params = {}) {
  if (!API_KEY) throw new Error("TWELVE_DATA_API_KEY fehlt in Render → Environment.");
  const url = new URL("https://api.twelvedata.com" + path);
  for (const [key, value] of Object.entries({ ...params, apikey: API_KEY })) {
    url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Twelve Data antwortete nicht mit JSON (HTTP ${response.status}).`); }
    if (!response.ok || data.status === "error") {
      throw new Error(data.message || `Twelve Data HTTP ${response.status}`);
    }
    return data;
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Twelve Data antwortet zu langsam (Timeout nach 12 s).");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, version: APP_VERSION, symbol: SYMBOL, apiKeyConfigured: Boolean(API_KEY), serverTime: new Date().toISOString() });
});

app.get("/api/price", async (req, res) => {
  try {
    const data = await td("/price", { symbol: SYMBOL });
    const price = Number(data.price);
    if (!Number.isFinite(price)) throw new Error("Twelve Data hat keinen gültigen Preis geliefert.");
    res.json({ status: "ok", symbol: SYMBOL, price, timestamp: Math.floor(Date.now() / 1000) });
  } catch (err) {
    jsonError(res, 502, err.message);
  }
});

app.get("/api/history", async (req, res) => {
  const allowed = new Set(["1min", "5min", "15min", "1h"]);
  const interval = allowed.has(req.query.interval) ? req.query.interval : "1min";
  let outputsize = Number(req.query.outputsize || 180);
  if (!Number.isFinite(outputsize)) outputsize = 180;
  outputsize = Math.max(60, Math.min(Math.floor(outputsize), 500));
  const key = `${SYMBOL}|${interval}|${outputsize}`;
  const cached = historyCache.get(key);
  if (cached && Date.now() - cached.ts < HISTORY_TTL_MS && Array.isArray(cached.values) && cached.values.length >= 2) {
    return res.json({ status: "ok", symbol: SYMBOL, interval, source: cached.source, cached: true, values: cached.values });
  }

  try {
    const data = await td("/time_series", {
      symbol: SYMBOL,
      interval,
      outputsize,
      order: "ASC",
      timezone: "UTC"
    });
    if (!Array.isArray(data.values) || data.values.length < 2) throw new Error("Twelve Data hat keine ausreichenden Kursdaten geliefert.");
    historyCache.set(key, { ts: Date.now(), source: "Twelve Data", values: data.values });
    res.json({ status: "ok", symbol: SYMBOL, interval, source: "Twelve Data", values: data.values });
  } catch (err) {
    console.warn(`Historie ${interval}: Twelve Data nicht verfügbar: ${err.message}`);
    try {
      const values = await fetchYahooHistory(interval, outputsize);
      historyCache.set(key, { ts: Date.now(), source: "Yahoo Finance Fallback", values });
      res.json({ status: "ok", symbol: SYMBOL, interval, source: "Yahoo Finance Fallback", values, warning: `Twelve Data: ${err.message}` });
    } catch (fallbackErr) {
      if (cached && Array.isArray(cached.values) && cached.values.length >= 2) {
        return res.json({ status: "ok", symbol: SYMBOL, interval, source: cached.source, cached: true, stale: true, values: cached.values, warning: `Live-Historie nicht verfügbar: ${err.message}` });
      }
      jsonError(res, 502, `Historische XAU/USD-Daten nicht verfügbar. Twelve Data: ${err.message}. Fallback: ${fallbackErr.message}`, { symbol: SYMBOL, interval });
    }
  }
});

function broadcast(payload) {
  const message = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(message);
  }
}

let tdSocket = null;
let reconnectTimer = null;
let lastTick = null;

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectTwelveData();
  }, 5000);
}

function connectTwelveData() {
  if (!API_KEY || (tdSocket && (tdSocket.readyState === WebSocket.OPEN || tdSocket.readyState === WebSocket.CONNECTING))) return;
  try {
    const socket = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(API_KEY)}`);
    tdSocket = socket;
    socket.on("open", () => {
      socket.send(JSON.stringify({ action: "subscribe", params: { symbols: SYMBOL } }));
      broadcast({ type: "status", connected: true, message: "Live-Feed verbunden" });
    });
    socket.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "price" && Number.isFinite(Number(msg.price))) {
          lastTick = { price: Number(msg.price), timestamp: Number(msg.timestamp) || Math.floor(Date.now()/1000) };
          broadcast({ type: "tick", symbol: SYMBOL, ...lastTick });
        } else if (msg.event === "subscribe-status") {
          broadcast({ type: "feed", message: JSON.stringify(msg) });
        } else if (msg.status === "error" || msg.code) {
          console.error("Twelve Data stream:", msg.message || JSON.stringify(msg));
          broadcast({ type: "status", connected: false, message: msg.message || "Live-Feed Fehler" });
        }
      } catch (e) { console.error("Stream JSON error:", e.message); }
    });
    socket.on("error", err => {
      console.error("Twelve Data WebSocket error:", err.message);
      broadcast({ type: "status", connected: false, message: "Live-Feed Fehler – Kursabfrage läuft weiter" });
    });
    socket.on("close", () => {
      if (tdSocket === socket) tdSocket = null;
      broadcast({ type: "status", connected: false, message: "Live-Feed getrennt – Kursabfrage läuft weiter" });
      scheduleReconnect();
    });
  } catch (e) {
    console.error("Twelve Data WebSocket init error:", e.message);
    scheduleReconnect();
  }
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({
    type: "status",
    connected: Boolean(tdSocket && tdSocket.readyState === WebSocket.OPEN),
    message: API_KEY ? "Kursdaten werden geladen…" : "API-Key fehlt"
  }));
  if (lastTick) ws.send(JSON.stringify({ type: "tick", symbol: SYMBOL, ...lastTick }));
});

app.get("/", (req, res) => res.sendFile(require("path").join(__dirname, "public", "index.html")));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`XAU/USD Analyzer v${APP_VERSION} läuft auf Port ${PORT}`);
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Twelve Data API-Key: ${API_KEY ? "konfiguriert" : "FEHLT"}`);
  connectTwelveData();
});


// Vantage/MT5 connection status endpoint.
// This intentionally performs NO login and NO order execution.
// It reports whether a future MT5 bridge is configured on the server.
function vantageStatus(_req, res) {
  const configuredServer = String(process.env.VANTAGE_MT5_SERVER || "VantageMarkets-Live").trim();
  const bridgeUrl = String(process.env.MT5_BRIDGE_URL || "").trim();
  const bridgeConfigured = bridgeUrl.length > 0;
  res.set("Cache-Control", "no-store");
  res.json({
    status:"ok",
    appVersion:APP_VERSION,
    connected:false,
    server:configuredServer,
    account:null,
    equity:null,
    bridgeConfigured,
    orderExecutionEnabled:false,
    message: bridgeConfigured
      ? "MT5-Bridge ist konfiguriert, aber die Live-Orderausführung ist weiterhin gesperrt."
      : "Kein MT5-Bridge-Dienst konfiguriert. Web-App und Marktanalyse funktionieren unabhängig davon."
  });
}
app.get("/api/vantage/status", vantageStatus);
app.post("/api/vantage/status", vantageStatus);
