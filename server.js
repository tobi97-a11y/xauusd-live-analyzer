
require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOL = process.env.XAU_SYMBOL || "XAU/USD";

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/stream" });

app.use(express.static("public"));

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

async function td(path, params = {}) {
  if (!API_KEY) throw new Error("TWELVE_DATA_API_KEY fehlt. Bitte .env anlegen.");
  const url = new URL("https://api.twelvedata.com" + path);
  Object.entries({ ...params, apikey: API_KEY }).forEach(([k, v]) => url.searchParams.set(k, v));
  const r = await fetch(url);
  const data = await r.json();
  if (!r.ok || data.status === "error") throw new Error(data.message || `HTTP ${r.status}`);
  return data;
}

app.get("/api/history", async (req, res) => {
  try {
    const interval = req.query.interval || "1min";
    const outputsize = Math.min(Number(req.query.outputsize || 300), 5000);
    const data = await td("/time_series", {
      symbol: SYMBOL, interval, outputsize, order: "ASC", timezone: "Europe/Berlin"
    });
    res.json(data);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.get("/api/price", async (req, res) => {
  try {
    const data = await td("/price", { symbol: SYMBOL });
    res.json(data);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

let tdSocket = null;

function connectTwelveData() {
  if (!API_KEY) return;
  try {
    tdSocket = new WebSocket(`wss://ws.twelvedata.com/v1/quotes/price?apikey=${API_KEY}`);
    tdSocket.on("open", () => {
      tdSocket.send(JSON.stringify({
        action: "subscribe",
        params: { symbols: SYMBOL }
      }));
      broadcast({ type: "status", connected: true, message: "Live-Feed verbunden" });
    });
    tdSocket.on("message", raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "price") {
          broadcast({
            type: "tick",
            symbol: msg.symbol || SYMBOL,
            price: Number(msg.price),
            timestamp: msg.timestamp || Math.floor(Date.now()/1000)
          });
        }
      } catch {}
    });
    tdSocket.on("close", () => {
      broadcast({ type: "status", connected: false, message: "Live-Feed getrennt; Reconnect..." });
      setTimeout(connectTwelveData, 3000);
    });
    tdSocket.on("error", () => {});
  } catch {}
}

wss.on("connection", ws => {
  ws.send(JSON.stringify({
    type: "status",
    connected: Boolean(API_KEY),
    message: API_KEY ? "Verbinde Live-Feed..." : "Demo-Modus: API-Key fehlt"
  }));
});

connectTwelveData();

app.get("/api/health", (req, res) => res.json({ok:true, symbol:SYMBOL, apiKeyConfigured:Boolean(API_KEY)}));

server.listen(PORT, "0.0.0.0", () => {
  console.log(`XAU/USD Analyzer läuft auf http://localhost:${PORT}`);
});
