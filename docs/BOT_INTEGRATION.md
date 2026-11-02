# Integración del motor de trading con Nexus

Nexus necesita **una sola cosa** de tu bot: un endpoint HTTP que devuelva tasas y capacidad de liquidez en JSON. El resto (cálculo de payout, benchmark de comisiones, firma, PayPal) vive en Nexus.

---

## 1. Diagnóstico del motor actual

Verificado contra `http://150.136.227.127:8501`:

| Sonda | Resultado |
|---|---|
| `GET /` | `200 text/html` — shell de Streamlit |
| `GET /_stcore/health` | `200 ok` |
| `GET /nexus/strategy` | `200 text/html` (Streamlit devuelve el shell en cualquier ruta) |
| `GET /api/strategy` | `200 text/html` |
| `GET /api/health` | `200 text/html` |

**Conclusión:** el motor está en línea, pero su estado interno no es accesible por HTTP. Streamlit mantiene el estado en la sesión WebSocket, no en un endpoint REST. Por eso Nexus:

1. marca el motor como **vinculado** (`source: bridge`);
2. usa un puente determinista para las tasas;
3. muestra `Puente Nexus` en la cotización y en el badge;
4. en cuanto publiques el feed, pasa a `source: bot` / `Motor en vivo` automáticamente.

---

## 2. Contrato recomendado

Publica un `GET /nexus/strategy` que devuelva:

```json
{
  "engine": "cdt-arbitrage",
  "updatedAt": "2026-10-27T21:30:00.000Z",
  "yieldBps": 87,
  "liquidityUsd": 248500,
  "confidence": 0.94,
  "rates": {
    "USD": 1,
    "EUR": 0.9214,
    "GBP": 0.7831,
    "MXN": 18.42,
    "BRL": 5.43,
    "COP": 4021.5,
    "ARS": 985.4,
    "CLP": 945.2,
    "PEN": 3.781,
    "JPY": 151.34
  }
}
```

### Reglas de las tasas

- `rates` expresa **unidades de moneda por 1 USD**.
- `USD` debe ser `1`.
- Se aceptan claves `USD/COP`, `USDCOP` o `COP`.
- Se aceptan valores numéricos o `{ "rate": 4021.5 }` / `{ "value": ... }` / `{ "price": ... }`.
- Si falta una tasa, Nexus la completa con el modelo determinista y etiqueta la cotización como `nexus-bridge` para ese par.

### Campos tolerados (alias)

| Campo | Alternativas |
|---|---|
| `rates` | `fxRates`, `fx.rates`, `market.rates`, `pairs`, `quotes` |
| `yieldBps` | `yield_bps`, `strategy.yieldBps`, `dailyYieldPct` (se multiplica por 100) |
| `liquidityUsd` | `liquidity_usd`, `liquidity`, `depthUsd`, `capitalUsd` |
| `confidence` | `strategy.confidence` (0–1) |
| `updatedAt` | `updated_at`, `timestamp` |
| `engine` | `name` |

Los números aceptan `$`, comas y sufijos `k`/`m` (`"$248k"` → `248000`).

### Límites de sanidad

Nexus rechaza una tasa si está fuera de `0.5×–2×` del valor de referencia, para evitar payouts absurdos por un bug del bot. En ese caso usa la referencia y lo marca como puente.

---

## 3. Opción A — Sidecar FastAPI (recomendada)

Streamlit no permite rutas REST arbitrarias. Ejecuta un sidecar en otro puerto (por ejemplo `8502`) que lea la telemetría que tu bot escribe en un archivo/Redis y la exponga por HTTP.

### 3.1 El bot escribe telemetría

En tu loop de trading (Streamlit o proceso aparte):

```python
import json
import os
import tempfile
import time

TELEMETRY_PATH = os.getenv("NEXUS_TELEMETRY", "/tmp/nexus_strategy.json")

def publish_telemetry(rates: dict, yield_bps: int, liquidity_usd: float, confidence: float = 0.94):
    """Escritura atómica para que el sidecar nunca lea un JSON a medias."""
    payload = {
        "engine": "cdt-arbitrage",
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "yieldBps": int(yield_bps),
        "liquidityUsd": float(liquidity_usd),
        "confidence": float(confidence),
        "rates": {"USD": 1, **rates},  # rates = unidades por 1 USD
    }
    directory = os.path.dirname(TELEMETRY_PATH)
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory)
    with os.fdopen(fd, "w") as handle:
        json.dump(payload, handle)
    os.replace(tmp, TELEMETRY_PATH)
```

Llama a `publish_telemetry(...)` en cada ciclo (o cada 5–15 s) con las tasas que ya usa tu estrategia.

### 3.2 El sidecar las publica

```python
# sidecar.py
import json
import os
import time
from fastapi import FastAPI, Header, HTTPException

app = FastAPI(title="Nexus Strategy Bridge")
TELEMETRY_PATH = os.getenv("NEXUS_TELEMETRY", "/tmp/nexus_strategy.json")
API_KEY = os.getenv("NEXUS_BOT_API_KEY", "")

@app.get("/_stcore/health")
def health():
    return "ok"

@app.get("/nexus/strategy")
def strategy(x_api_key: str | None = Header(default=None)):
    if API_KEY and x_api_key != API_KEY:
        raise HTTPException(status_code=401, detail="invalid api key")
    try:
        with open(TELEMETRY_PATH, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
    except (OSError, ValueError):
        raise HTTPException(status_code=503, detail="telemetry not ready")
    payload.setdefault("updatedAt", time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    return payload
```

```bash
pip install fastapi uvicorn
NEXUS_TELEMETRY=/tmp/nexus_strategy.json \
NEXUS_BOT_API_KEY=un-secreto \
uvicorn sidecar:app --host 0.0.0.0 --port 8502
```

En Nexus:

```env
BOT_URL=http://IP-DEL-SERVIDOR:8502
BOT_API_KEY=un-secreto
BOT_STRATEGY_PATH=/nexus/strategy
```

> Si el puerto 8502 no es accesible públicamente, publica el sidecar detrás de Nginx con TLS y deja `BOT_URL=https://bot.tudominio.com`. Nunca expongas el puerto de administración de Streamlit sin autenticación.

### 3.3 Nginx (mismo dominio, path proxy)

```nginx
location /nexus/ {
    proxy_pass http://127.0.0.1:8502;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location / {
    proxy_pass http://127.0.0.1:8501;   # Streamlit
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

Entonces `BOT_URL=https://bot.tudominio.com` y `BOT_STRATEGY_PATH=/nexus/strategy`.

---

## 4. Opción B — mock local (ya incluido)

```bash
npm run mock-bot
```

- `http://localhost:8501/` → shell tipo Streamlit.
- `http://localhost:8501/_stcore/health` → `ok`.
- `http://localhost:8501/nexus/strategy` → JSON con tasas, yield y liquidez.
- `MOCK_BOT_API_KEY` opcional para probar `BOT_API_KEY`.

En otra terminal:

```bash
BOT_URL=http://localhost:8501 NEXUS_OFFLINE=0 npm start
```

La UI debe mostrar `Motor en vivo` y `Fuente de estrategia: Motor en vivo`.

---

## 5. Verificar la integración

```bash
curl -s http://150.136.227.127:8501/nexus/strategy | head
curl -s http://150.136.227.127:8501/_stcore/health
```

Desde Nexus:

```bash
curl -s http://localhost:3000/api/agent/status | jq
```

Respuesta esperada con feed válido:

```json
{
  "engine": "live",
  "source": "bot",
  "feedExposed": true,
  "label": "Motor en vivo",
  "strategy": {
    "yieldBps": 87,
    "liquidityUsd": 248500,
    "pairCount": 25
  }
}
```

Con el bot actual (sin feed):

```json
{
  "engine": "linked",
  "source": "bridge",
  "feedExposed": false,
  "label": "Motor en línea · puente"
}
```

Sin respuesta:

```json
{ "engine": "offline", "source": "simulated" }
```

---

## 6. Timeouts, caché y fallback

| Ajuste | Default | Efecto |
|---|---|---|
| `BOT_TIMEOUT_MS` | `3500` | Tiempo máximo por sonda |
| `BOT_CACHE_MS` | `15000` | La UI no golpea el bot en cada request |
| `BOT_STRATEGY_PATH` | 4 rutas | Se prueban en orden hasta encontrar JSON válido |
| `NEXUS_OFFLINE` | `0` | `1` fuerza simulación para CI/demos sin red |

El adaptador nunca lanza un error hacia la UI: si el bot falla, responde con `simulated` y la terminal lo muestra como advertencia. La disponibilidad de PayPal no depende del bot.

---

## 7. Seguridad

- Usa `BOT_API_KEY` y exige `X-API-Key` en el sidecar.
- Sirve el feed por TLS; no publiques `http://` en producción.
- Limita el sidecar a lectura: no expongas claves de exchange ni endpoints de trading.
- Rota el secreto y restringe por IP si es posible.
- El adaptador sólo hace `GET` a rutas configuradas; no acepta URLs del cliente (sin SSRF).
