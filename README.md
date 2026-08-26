# XAU/USD Live Analyzer

Mobile Web-App für XAU/USD mit Live-Kurs, Multi-Timeframe-Analyse und technischem BUY/SELL/NEUTRAL-Signal.

## GitHub → Render → iPhone

### 1. Repository erstellen
Auf GitHub ein neues Repository erstellen, z. B. `xauusd-live-analyzer`.

### 2. Dateien hochladen
Alle Dateien aus diesem Ordner in das Repository hochladen.

### 3. Render verbinden
Auf Render ein neues **Web Service** aus dem GitHub-Repository erstellen.

Build Command:
`npm install`

Start Command:
`npm start`

### 4. API-Key als Secret
In Render unter Environment Variables:
`TWELVE_DATA_API_KEY` = dein Twelve-Data-API-Key

Nicht in GitHub committen.

### 5. iPhone
Nach dem Deployment die Render-URL in Safari öffnen und:
**Teilen → Zum Home-Bildschirm**

Dann lässt sich die Web-App wie eine App vom iPhone starten.

## Hinweis
Das Modell liefert technische Entscheidungshilfe, keine Garantie für die Kursrichtung und keine individuelle Anlageberatung. Vor echtem Trading sollte das Signal umfangreich backgetestet und um Spread, Slippage, News/Makro, Regimewechsel und Risikomanagement ergänzt werden.
