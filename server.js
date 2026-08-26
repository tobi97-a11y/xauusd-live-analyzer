require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = Number(process.env.PORT || 10000);
const API_KEY = String(process.env.TWELVE_DATA_API_KEY || "").trim();
const SYMBOL = String(process.env.XAU_SYMBOL || "XAU/USD").trim();
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/stream" });

app.disable("x-powered-by");
app.use(express.static("public", { extensions: ["html"] }));

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
  res.json({ ok: true, symbol: SYMBOL, apiKeyConfigured: Boolean(API_KEY), serverTime: new Date().toISOString() });
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
  try {
    const data = await td("/time_series", {
      symbol: SYMBOL,
      interval,
      outputsize,
      order: "ASC",
      timezone: "UTC"
    });
    if (!Array.isArray(data.values) || data.values.length < 2) {
      throw new Error("Twelve Data hat keine ausreichenden Kursdaten geliefert.");
    }
    res.json({ status: "ok", symbol: SYMBOL, interval, values: data.values });
  } catch (err) {
    jsonError(res, 502, err.message, { symbol: SYMBOL, interval });
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
  console.log(`XAU/USD Analyzer läuft auf Port ${PORT}`);
  console.log(`Symbol: ${SYMBOL}`);
  console.log(`Twelve Data API-Key: ${API_KEY ? "konfiguriert" : "FEHLT"}`);
  connectTwelveData();
});
