'use strict';

/**
 * PayPal Nexus AI — browser client.
 * Vanilla ES2020, zero build step. All money values are computed and signed
 * on the server; this file only renders and orchestrates the UI.
 */
(() => {
  const state = {
    config: null,
    quote: null,
    dashboard: null,
    status: null,
    running: false,
    statusInFlight: false,
    sdkCurrency: null,
    sdkPromise: null,
    sdk: null,
  };

  const formatters = new Map();
  let editTimer = null;
  let statusTimer = null;
  let modalCleanup = null;
  let lastFocusedElement = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const els = {};
  function cacheElements() {
    const ids = [
      'mode-badge', 'engine-pill', 'engine-pill-text', 'hero-env',
      'metric-yield', 'metric-liquidity', 'metric-latency', 'chip-engine',
      'transfer-form', 'amount', 'source-country', 'destination-country',
      'source-symbol', 'source-currency', 'amount-help', 'recipient-email',
      'route-from', 'route-to', 'preview-receive', 'preview-rate',
      'optimize-btn', 'optimize-label', 'optimize-spinner', 'swap-btn',
      'agent-state', 'agent-state-text', 'agent-log', 'terminal-mode',
      'agent-foot', 'agent-latency', 'terminal-bot-url',
      'quote-panel', 'quote-route', 'quote-send', 'quote-receive', 'quote-save',
      'quote-rate', 'quote-benchmark-fee', 'quote-benchmark-fx', 'quote-coverage',
      'quote-source', 'paypal-button-container', 'demo-paypal-btn', 'paypal-hint',
      'quote-reset', 'agent-empty', 'agent-empty-title', 'agent-empty-text',
      'stat-count', 'stat-count-sub', 'stat-volume', 'stat-savings',
      'stat-savings-pct', 'savings-chart', 'chart-total', 'chart-caption',
      'ledger-body', 'ledger-count', 'demo-data-note', 'refresh-dashboard',
      'corridor-list', 'corridor-count',
      'toast-region', 'modal-root', 'how-yield', 'how-depth',
    ];
    for (const id of ids) els[id] = document.getElementById(id);
  }

  // ---------------------------------------------------------------- utils

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function nf(decimals = 2) {
    if (!formatters.has(decimals)) {
      formatters.set(
        decimals,
        new Intl.NumberFormat('en-US', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }),
      );
    }
    return formatters.get(decimals);
  }

  function currencyMeta(code) {
    return state.config?.currencies?.[code] || { symbol: code, decimals: 2, name: code };
  }

  function fmtNumber(value, decimals = 2) {
    return nf(decimals).format(Number(value) || 0);
  }

  function fmtMoney(value, currency, withCode = false) {
    const meta = currencyMeta(currency);
    const formatted = `${meta.symbol || ''}${fmtNumber(value, meta.decimals ?? 2)}`;
    return withCode ? `${formatted} ${currency}` : formatted;
  }

  function fmtUnit(value, currency) {
    const meta = currencyMeta(currency);
    return `${fmtNumber(value, meta.decimals ?? 2)} ${currency}`;
  }

  function fmtUsd(value, decimals = 2) {
    return `$${fmtNumber(value, decimals)}`;
  }

  function fmtUsdCompact(value) {
    const n = Number(value) || 0;
    if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
    if (n >= 100_000) return `$${Math.round(n / 1000)}K`;
    if (n >= 1000) return `$${nf(0).format(n)}`;
    return `$${nf(2).format(n)}`;
  }

  function fmtRate(value) {
    const n = Number(value) || 0;
    const decimals = n >= 100 ? 2 : n >= 1 ? 4 : 6;
    return fmtNumber(n, decimals);
  }

  function fmtDate(iso) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('es', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(date)
      .replace('.', '');
  }

  function fmtTime(date = new Date()) {
    return new Intl.DateTimeFormat('es', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date);
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => {
      if (char === '&') return '&amp;';
      if (char === '<') return '&lt;';
      if (char === '>') return '&gt;';
      if (char === '"') return '&quot;';
      return '&#39;';
    });
  }

  function statusLabel(status) {
    const labels = {
      COMPLETED: 'Completado',
      PENDING: 'Pendiente',
      CREATED: 'Creado',
      DECLINED: 'Rechazado',
      FAILED: 'Fallido',
    };
    const key = String(status || '').toUpperCase();
    return labels[key] || status || '—';
  }

  function currentCountry(code) {
    return state.config?.countries?.find((country) => country.code === code) || null;
  }

  function sourceCurrency() {
    return currentCountry(els['source-country'].value)?.currency || 'USD';
  }

  // ------------------------------------------------------------------ api

  async function apiRequest(path, { method = 'GET', body } = {}) {
    const response = await fetch(path, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(data?.error?.message || `La solicitud falló (HTTP ${response.status}).`);
      error.code = data?.error?.code;
      error.status = response.status;
      error.details = data?.error?.details;
      throw error;
    }
    return data;
  }

  // --------------------------------------------------------------- toasts

  function toast(title, message = '', type = 'info') {
    const region = els['toast-region'];
    if (!region) return;

    const item = document.createElement('div');
    item.className = `toast is-${type}`;

    const icon = document.createElement('span');
    icon.className = 'toast-icon';
    icon.textContent = type === 'success' ? '✓' : type === 'error' ? '!' : 'i';

    const copy = document.createElement('div');
    copy.className = 'toast-copy';
    const strong = document.createElement('strong');
    strong.textContent = title;
    copy.appendChild(strong);
    if (message) {
      const p = document.createElement('p');
      p.textContent = message;
      copy.appendChild(p);
    }

    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Cerrar notificación');
    close.textContent = '×';

    item.append(icon, copy, close);
    region.appendChild(item);

    let timer = setTimeout(() => item.remove(), 5600);
    close.addEventListener('click', () => {
      clearTimeout(timer);
      item.remove();
    });
    item.addEventListener('mouseenter', () => clearTimeout(timer));
    item.addEventListener('mouseleave', () => {
      timer = setTimeout(() => item.remove(), 2600);
    });
  }

  // --------------------------------------------------------------- config

  async function init() {
    cacheElements();
    bindEvents();
    resetTerminalIdle();

    try {
      const config = await apiRequest('/api/config');
      state.config = config;
      applyConfig(config);
    } catch (error) {
      handleBootError(error);
      return;
    }

    loadStatus();
    loadDashboard();
    statusTimer = setInterval(loadStatus, 30_000);

    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'cancel') {
      toast('Pago cancelado', 'Puedes generar una nueva cotización cuando quieras.', 'info');
    }
  }

  function handleBootError(error) {
    els['mode-badge'].textContent = 'API OFFLINE';
    els['mode-badge'].className = 'badge badge-demo';
    els['engine-pill-text'].textContent = 'API sin conexión';
    els['engine-pill'].classList.add('is-offline');
    els['optimize-btn'].disabled = true;
    appendLog({
      glyph: '✕',
      text: 'No se pudo cargar la configuración de Nexus.',
      detail: error.message,
      tone: 'error',
    });
    toast('No se pudo iniciar Nexus', error.message, 'error');
  }

  function applyConfig(config) {
    const mode = config.app.mode;
    const badge = els['mode-badge'];
    badge.className = `badge ${mode === 'demo' ? 'badge-demo' : mode === 'live' ? 'badge-live' : 'badge-sandbox'}`;
    badge.textContent = mode === 'demo' ? 'DEMO · SANDBOX' : mode === 'live' ? 'PAYPAL LIVE' : 'PAYPAL SANDBOX';
    badge.title =
      mode === 'demo'
        ? 'Sin credenciales de PayPal: el checkout se simula.'
        : `PayPal ${config.app.environment} · Orders v2`;

    els['hero-env'].textContent = mode === 'demo' ? 'SANDBOX · DEMO' : 'SANDBOX';
    els['terminal-bot-url'].textContent = config.bot.url;
    els['terminal-bot-url'].title = config.bot.url;

    fillSelect(
      els['source-country'],
      config.countries.filter((country) => country.send),
      'US',
    );
    fillSelect(
      els['destination-country'],
      config.countries.filter((country) => country.receive),
      'CO',
    );

    updateCurrencyUI();
    updateRoutePreview();
    updatePayPalHint();

    els['how-yield'].textContent = '— bps';
    els['how-depth'].textContent = '—';
  }

  function fillSelect(select, countries, selectedCode) {
    select.replaceChildren();
    for (const country of countries) {
      const option = document.createElement('option');
      option.value = country.code;
      option.textContent = country.name;
      select.appendChild(option);
    }
    if (countries.some((country) => country.code === selectedCode)) {
      select.value = selectedCode;
    }
  }

  function updateCurrencyUI() {
    const country = currentCountry(els['source-country'].value);
    if (!country) return;
    const meta = currencyMeta(country.currency);

    els['source-symbol'].textContent = meta.symbol || country.currency;
    els['source-currency'].textContent = country.currency;
    els.amount.step = meta.decimals === 0 ? '1' : '0.01';

    const limits = state.config?.limits || { minAmount: 1, maxAmount: 25000 };
    els['amount-help'].textContent = `Mínimo ${fmtMoney(limits.minAmount, country.currency)} · máximo ${fmtMoney(limits.maxAmount, country.currency)}`;

    $$('.quick-amount').forEach((button) => {
      const value = Number(button.dataset.amount);
      button.textContent = `${meta.symbol}${nf(0).format(value)}`;
    });
  }

  function updateRoutePreview() {
    const source = currentCountry(els['source-country'].value);
    const destination = currentCountry(els['destination-country'].value);
    els['route-from'].textContent = source ? `${source.name} · ${source.currency}` : '—';
    els['route-to'].textContent = destination ? `${destination.name} · ${destination.currency}` : '—';
  }

  function updatePayPalHint() {
    if (!state.config) return;
    if (state.config.app.mode === 'demo') {
      els['paypal-hint'].textContent =
        'Modo demo: se simula la autorización. Añade PAYPAL_CLIENT_ID y PAYPAL_CLIENT_SECRET para el checkout oficial.';
    } else {
      els['paypal-hint'].textContent = 'Se abrirá el checkout seguro de PayPal Sandbox.';
    }
  }

  // ------------------------------------------------------------- transfers

  function readInput() {
    return {
      amount: Number(els.amount.value),
      sourceCountry: els['source-country'].value,
      destinationCountry: els['destination-country'].value,
      recipientEmail: els['recipient-email'].value.trim() || undefined,
    };
  }

  function validateInput(input) {
    if (!Number.isFinite(input.amount) || input.amount <= 0) return 'Ingresa un monto mayor que cero.';
    if (!input.sourceCountry || !input.destinationCountry) return 'Selecciona origen y destino.';
    if (input.sourceCountry === input.destinationCountry) return 'El destino debe ser distinto al origen.';

    const limits = state.config?.limits || { minAmount: 1, maxAmount: 25000 };
    const country = currentCountry(input.sourceCountry);
    if (input.amount < limits.minAmount) {
      return `El mínimo es ${fmtMoney(limits.minAmount, country?.currency)}.`;
    }
    if (input.amount > limits.maxAmount) {
      return `El máximo es ${fmtMoney(limits.maxAmount, country?.currency)} por transferencia.`;
    }
    if (
      input.recipientEmail &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(input.recipientEmail)
    ) {
      return 'El correo del destinatario no es válido.';
    }
    return null;
  }

  async function handleOptimize(event) {
    event.preventDefault();
    if (state.running) return;
    if (!state.config) {
      toast('Configuración no disponible', 'Recarga la página para reconectar con Nexus.', 'error');
      return;
    }

    const input = readInput();
    const validationError = validateInput(input);
    if (validationError) {
      toast('Revisa tu transferencia', validationError, 'error');
      els.amount.focus();
      return;
    }

    state.running = true;
    state.quote = null;
    prepareForRun(input);
    setOptimizeState(true);

    try {
      const data = await apiRequest('/api/agent/optimize', { method: 'POST', body: input });
      const quote = data.quote;

      setAgentState('working', 'Optimizando');
      await playSteps(quote);
      state.quote = quote;
      applyQuote(quote);

      setAgentState('success', 'Cobertura activa');
      setTerminalMode('READY');
      els['agent-foot'].textContent = 'Cobertura confirmada · tarifa al usuario $0.00';
      els['agent-latency'].textContent = `${quote.processingMs ?? '—'} ms`;
      els['agent-empty'].hidden = true;

      toast(
        'Ruta optimizada',
        `Comisión absorbida: 100% (${fmtMoney(quote.savings.amount, quote.sourceCurrency)}).`,
        'success',
      );

      if (window.matchMedia('(max-width: 900px)').matches) {
        els['quote-panel'].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (error) {
      setAgentState('error', 'Error');
      setTerminalMode('FAIL');
      els['agent-foot'].textContent = 'La optimización se detuvo';
      appendLog({
        glyph: '✕',
        text: 'No se pudo completar la optimización.',
        detail: error.message,
        tone: 'error',
      });
      setAgentEmpty('No pudimos calcular la ruta.', error.message);
      els['agent-empty'].hidden = false;
      els['preview-rate'].textContent = 'La tasa óptima se calcula al optimizar';
      toast('Optimización fallida', error.message, 'error');
    } finally {
      state.running = false;
      setOptimizeState(false);
    }
  }

  function prepareForRun(input) {
    els['quote-panel'].hidden = true;
    els['agent-empty'].hidden = true;
    els['paypal-button-container'].replaceChildren();
    els['demo-paypal-btn'].hidden = true;
    els['preview-receive'].textContent = '—';
    els['preview-rate'].textContent = 'Calculando la tasa óptima…';
    setTerminalMode('RUNNING');
    resetTerminal(`${input.sourceCountry} → ${input.destinationCountry}`, input.amount, sourceCurrency());
  }

  function resetTerminal(route, amount, currency) {
    els['agent-log'].replaceChildren();
    appendLog({
      glyph: '$',
      text: `nexus optimize --from ${route.split(' → ')[0]} --to ${route.split(' → ')[1]} --amount ${amount} ${currency}`,
      tone: 'command',
    });
    appendLog({
      glyph: '›',
      text: `Handshake con ${state.config?.bot?.url || 'el motor'}…`,
      tone: 'muted',
    });
    els['agent-foot'].textContent = 'Negociando cobertura…';
  }

  function resetTerminalIdle() {
    if (!els['agent-log']) return;
    els['agent-log'].replaceChildren();
    appendLog({ glyph: '›', text: 'Esperando una transferencia para optimizar.', tone: 'muted' });
    appendLog({
      glyph: '›',
      text: `Motor: ${state.config?.bot?.url || 'http://150.136.227.127:8501'}`,
      tone: 'muted',
      time: '--:--:--',
    });
  }

  async function playSteps(quote) {
    const steps = quote.steps || [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const line = appendLog({
        glyph: '◌',
        text: step.label,
        tone: 'running',
        spin: true,
      });
      els['agent-foot'].textContent = `Paso ${index + 1}/${steps.length} · ${step.label.toLowerCase()}…`;
      await sleep(230);

      finalizeLog(line, step.status === 'warn' ? '!' : '✓', step.status === 'warn' ? 'warn' : 'success');
      appendDetail(line, step.detail, step.durationMs);
      await sleep(140);
    }

    const summary = appendLog({
      glyph: '●',
      text: `Comisión absorbida: 100% ($0.00 ${quote.sourceCurrency} en tarifas)`,
      tone: 'summary',
    });
    summary.classList.add('is-summary');
    appendDetail(summary, quote.summary, null);
  }

  function appendLog({ glyph = '›', text = '', tone = '', time = null, spin = false }) {
    const line = document.createElement('div');
    line.className = 'log-line';
    if (tone) line.classList.add(`is-${tone}`);

    const timeEl = document.createElement('span');
    timeEl.className = 'log-time';
    timeEl.textContent = time || fmtTime();

    const glyphEl = document.createElement('span');
    glyphEl.className = `log-glyph${spin ? ' is-spinning' : ''}`;
    glyphEl.textContent = glyph;

    const textEl = document.createElement('span');
    textEl.className = 'log-text';
    textEl.textContent = text;

    line.append(timeEl, glyphEl, textEl);
    els['agent-log'].appendChild(line);
    els['agent-log'].scrollTop = els['agent-log'].scrollHeight;
    return line;
  }

  function appendDetail(line, text, durationMs) {
    if (!text) return;
    const detail = document.createElement('span');
    detail.className = 'log-detail';
    detail.textContent = text;
    if (durationMs !== null && durationMs !== undefined) {
      const ms = document.createElement('span');
      ms.className = 'log-ms';
      ms.textContent = `+${Math.max(0, Math.round(durationMs))} ms`;
      detail.appendChild(ms);
    }
    line.appendChild(detail);
    els['agent-log'].scrollTop = els['agent-log'].scrollHeight;
  }

  function finalizeLog(line, glyph, tone) {
    const glyphEl = line.querySelector('.log-glyph');
    if (glyphEl) {
      glyphEl.textContent = glyph;
      glyphEl.classList.remove('is-spinning');
    }
    line.classList.remove('is-running');
    if (tone) line.classList.add(`is-${tone}`);
  }

  function applyQuote(quote) {
    els['quote-panel'].hidden = false;
    els['agent-empty'].hidden = true;

    els['quote-route'].textContent = `${quote.corridor.fromName} → ${quote.corridor.toName}`;
    els['quote-send'].textContent = fmtMoney(quote.amount, quote.sourceCurrency, true);
    els['quote-receive'].textContent = fmtUnit(quote.recipientAmount, quote.recipientCurrency);
    els['quote-save'].textContent = `+${fmtMoney(quote.savings.amount, quote.sourceCurrency)}`;
    els['quote-rate'].textContent = `${fmtRate(quote.exchangeRate)} ${quote.recipientCurrency}`;
    els['quote-rate'].title = `1 ${quote.sourceCurrency} = ${fmtNumber(quote.exchangeRate, 6)} ${quote.recipientCurrency}`;

    els['quote-benchmark-fee'].textContent = `-${fmtMoney(quote.fees.benchmark.paypalFee, quote.sourceCurrency)}`;
    els['quote-benchmark-fx'].textContent = `-${fmtNumber(quote.fees.benchmark.fxPct, 2)}%`;
    els['quote-coverage'].textContent = `${quote.strategy.coveragePct}% · ${fmtUsdCompact(quote.strategy.capacityUsd)} de capacidad`;
    els['quote-source'].textContent = sourceLabel(quote.strategy.source);
    els['quote-source'].className = `source-${quote.strategy.source}`;
    els['quote-source'].title = `${quote.strategy.label} · ${quote.strategy.endpoint || quote.strategy.botUrl}`;

    els['preview-receive'].textContent = fmtUnit(quote.recipientAmount, quote.recipientCurrency);
    els['preview-rate'].textContent = `1 ${quote.sourceCurrency} = ${fmtRate(quote.exchangeRate)} ${quote.recipientCurrency} · mid-market · ${rateSourceLabel(quote.strategy.rateSource)}`;

    setupPayPal(quote);
  }

  function sourceLabel(source) {
    if (source === 'bot') return 'Motor en vivo';
    if (source === 'bridge') return 'Puente Nexus';
    return 'Simulación';
  }

  function rateSourceLabel(rateSource) {
    if (rateSource === 'live-bot') return 'feed del bot';
    if (rateSource === 'nexus-bridge') return 'puente Nexus';
    return 'simulación';
  }

  function clearQuote(message) {
    state.quote = null;
    els['quote-panel'].hidden = true;
    els['paypal-button-container'].replaceChildren();
    els['demo-paypal-btn'].hidden = true;
    els['preview-receive'].textContent = '—';
    els['preview-rate'].textContent = 'La tasa óptima se calcula al optimizar';
    setAgentState('idle', 'En espera');
    setTerminalMode('IDLE');
    els['agent-foot'].textContent = 'Listo para ejecutar';
    if (message) {
      setAgentEmpty('Cotización invalidada.', message);
      els['agent-empty'].hidden = false;
    }
  }

  function setAgentEmpty(title, text) {
    els['agent-empty-title'].textContent = title;
    els['agent-empty-text'].textContent = text;
  }

  function setAgentState(name, label) {
    els['agent-state'].dataset.state = name;
    els['agent-state-text'].textContent = label;
  }

  function setTerminalMode(mode) {
    els['terminal-mode'].textContent = mode;
  }

  function setOptimizeState(running) {
    els['optimize-btn'].disabled = running;
    els['optimize-btn'].setAttribute('aria-busy', String(running));
    els['optimize-spinner'].hidden = !running;
    els['optimize-label'].textContent = running ? 'Optimizando ruta…' : 'Optimizar con Nexus AI';

    for (const field of [els.amount, els['source-country'], els['destination-country'], els['recipient-email']]) {
      field.disabled = running;
    }
    $$('.quick-amount').forEach((button) => {
      button.disabled = running;
    });
    els['swap-btn'].disabled = running;
  }

  // -------------------------------------------------------------- payments

  function loadPayPalSdk(currency) {
    if (window.paypal && state.sdkCurrency === currency && state.sdk) {
      return Promise.resolve(state.sdk);
    }
    if (state.sdkPromise && state.sdkCurrency === currency) return state.sdkPromise;

    state.sdkCurrency = currency;
    state.sdk = null;
    state.sdkPromise = new Promise((resolve, reject) => {
      document.querySelectorAll('script[data-paypal-sdk]').forEach((script) => script.remove());
      try {
        delete window.paypal;
      } catch {
        /* ignore */
      }

      const script = document.createElement('script');
      const params = new URLSearchParams({
        'client-id': state.config.paypal.clientId,
        currency,
        intent: 'capture',
        components: 'buttons',
      });
      script.src = `https://www.paypal.com/sdk/js?${params.toString()}`;
      script.async = true;
      script.dataset.paypalSdk = '1';

      const timeout = setTimeout(() => {
        script.remove();
        reject(new Error('Tiempo de espera agotado al cargar PayPal.'));
      }, 15_000);

      script.onload = () => {
        clearTimeout(timeout);
        if (window.paypal) {
          state.sdk = window.paypal;
          resolve(window.paypal);
        } else {
          reject(new Error('PayPal SDK no expuso la API de botones.'));
        }
      };
      script.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('No se pudo cargar el SDK de PayPal.'));
      };

      document.head.appendChild(script);
    });

    state.sdkPromise.catch(() => {
      state.sdkPromise = null;
    });
    return state.sdkPromise;
  }

  async function setupPayPal(quote) {
    const container = els['paypal-button-container'];
    const demoButton = els['demo-paypal-btn'];
    container.replaceChildren();
    container.hidden = true;
    demoButton.hidden = true;
    demoButton.disabled = false;
    demoButton.dataset.action = '';
    const demoLabel = demoButton.querySelector('.demo-label');
    if (demoLabel) demoLabel.textContent = 'Pagar con PayPal';

    const canUseOfficial =
      state.config?.paypal?.configured &&
      state.config?.paypal?.clientId &&
      state.config?.app?.mode !== 'demo';

    if (!canUseOfficial) {
      updatePayPalHint();
      demoButton.hidden = false;
      return;
    }

    els['paypal-hint'].textContent = 'Checkout oficial de PayPal Sandbox. La orden se crea en el servidor.';
    container.hidden = false;

    try {
      const sdk = await loadPayPalSdk(quote.sourceCurrency);
      if (state.quote !== quote) return;
      const buttons = sdk.Buttons({
        style: { layout: 'horizontal', color: 'blue', shape: 'pill', label: 'paypal', height: 48 },
        createOrder: async () => {
          const data = await apiRequest('/api/paypal/create-order', {
            method: 'POST',
            body: { quoteId: quote.id, quoteToken: quote.token },
          });
          return data.order.id;
        },
        onApprove: async (data) => {
          try {
            const result = await apiRequest('/api/paypal/capture-order', {
              method: 'POST',
              body: { orderId: data.orderID, quoteToken: quote.token },
            });
            openReceipt(result.transaction, result.capture, quote);
            loadDashboard();
          } catch (error) {
            toast('Pago no capturado', error.message, 'error');
          }
        },
        onCancel: () => {
          toast('Pago cancelado', 'Tu cotización sigue activa durante 10 minutos.', 'info');
        },
        onError: (error) => {
          console.error('PayPal error', error);
          toast('PayPal devolvió un error', 'Revisa la consola Sandbox y vuelve a intentar.', 'error');
        },
      });

      await buttons.render(container);
    } catch (error) {
      if (state.quote !== quote) return;
      console.error(error);
      container.hidden = true;
      demoButton.hidden = false;
      demoButton.dataset.action = 'retry-paypal';
      if (demoLabel) demoLabel.textContent = 'Reintentar PayPal';
      els['paypal-hint'].textContent = `No se pudo cargar PayPal: ${error.message}`;
    }
  }

  function openDemoCheckout(quote) {
    const html = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="checkout-title" tabindex="-1">
          <div class="modal-head">
            <div>
              <p class="modal-kicker">PayPal Sandbox · demo</p>
              <h2 class="modal-title" id="checkout-title">Autoriza tu transferencia</h2>
            </div>
            <button type="button" class="modal-close" data-close aria-label="Cerrar">✕</button>
          </div>
          <div class="checkout-banner">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M10 2.5 16 5v4.4c0 3.7-2.5 6.7-6 8.1-3.5-1.4-6-4.4-6-8.1V5l6-2.5Z" stroke="currentColor" stroke-width="1.3" /><path d="M10 8v3.2M10 13.6v.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" /></svg>
            <span>Simulación de checkout: no se moverá dinero real. Configura credenciales Sandbox para usar el botón oficial de PayPal.</span>
          </div>
          <div class="modal-summary">
            <div class="modal-row"><span>Corredor</span><span>${escapeHtml(quote.corridor.from)} → ${escapeHtml(quote.corridor.to)}</span></div>
            <div class="modal-row"><span>Envías</span><span>${escapeHtml(fmtMoney(quote.amount, quote.sourceCurrency, true))}</span></div>
            <div class="modal-row"><span>Comisión Nexus</span><span>$0.00</span></div>
            <div class="modal-row"><span>Destinatario recibe</span><span>${escapeHtml(fmtUnit(quote.recipientAmount, quote.recipientCurrency))}</span></div>
            <div class="modal-row"><span>Ahorro absorbido</span><span>+${escapeHtml(fmtMoney(quote.savings.amount, quote.sourceCurrency))}</span></div>
            ${quote.input.recipientEmail ? `<div class="modal-row"><span>Correo destino</span><span>${escapeHtml(quote.input.recipientEmail)}</span></div>` : ''}
            <div class="modal-row is-total"><span>Total a pagar</span><span>${escapeHtml(fmtMoney(quote.amount, quote.sourceCurrency))}</span></div>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn btn-primary" id="demo-confirm" data-autofocus>
              <span class="btn-spinner" id="demo-spinner" hidden aria-hidden="true"></span>
              <span id="demo-confirm-label">Simular pago de ${escapeHtml(fmtMoney(quote.amount, quote.sourceCurrency))}</span>
            </button>
            <button type="button" class="btn btn-ghost" data-close>Cancelar</button>
          </div>
          <p class="modal-secure">
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="4.5" y="8.5" width="11" height="8" rx="2" stroke="currentColor" stroke-width="1.2" /><path d="M7 8.5V6.7a3 3 0 0 1 6 0v1.8" stroke="currentColor" stroke-width="1.2" /></svg>
            Orden protegida · PayPal Orders v2 · Sandbox
          </p>
        </div>
      </div>`;

    const { dialog } = openModal(html);
    const confirm = dialog.querySelector('#demo-confirm');
    const spinner = dialog.querySelector('#demo-spinner');
    const label = dialog.querySelector('#demo-confirm-label');

    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      spinner.hidden = false;
      label.textContent = 'Procesando pago…';
      try {
        const order = await apiRequest('/api/paypal/create-order', {
          method: 'POST',
          body: { quoteId: quote.id, quoteToken: quote.token },
        });
        const result = await apiRequest('/api/paypal/capture-order', {
          method: 'POST',
          body: { orderId: order.order.id, quoteToken: quote.token },
        });
        openReceipt(result.transaction, result.capture, quote);
        loadDashboard();
      } catch (error) {
        confirm.disabled = false;
        spinner.hidden = true;
        label.textContent = `Simular pago de ${fmtMoney(quote.amount, quote.sourceCurrency)}`;
        toast('Pago no completado', error.message, 'error');
      }
    });
  }

  function openReceipt(transaction, capture, quote) {
    const isDemo = transaction.demo;
    const html = `
      <div class="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="receipt-title" tabindex="-1">
          <div class="modal-head">
            <div>
              <p class="modal-kicker">${isDemo ? 'PayPal Sandbox · demo' : 'PayPal Sandbox · capturado'}</p>
              <h2 class="modal-title" id="receipt-title">Recibo de la transferencia</h2>
            </div>
            <button type="button" class="modal-close" data-close aria-label="Cerrar">✕</button>
          </div>
          <div class="receipt">
            <span class="receipt-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none"><path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            </span>
            <h3>Transferencia optimizada</h3>
            <p>Comisión absorbida: 100% · tarifa al usuario $0.00</p>
            <div class="receipt-amount">
              <span>Destinatario recibe</span>
              <strong>${escapeHtml(fmtUnit(quote.recipientAmount, quote.recipientCurrency))}</strong>
            </div>
            <div class="receipt-meta">
              <div class="modal-row"><span>Estado</span><span>${escapeHtml(statusLabel(capture.status || transaction.status))}</span></div>
              <div class="modal-row"><span>Enviaste</span><span>${escapeHtml(fmtMoney(transaction.amount, transaction.sourceCurrency, true))}</span></div>
              <div class="modal-row"><span>Ahorraste</span><span>+${escapeHtml(fmtMoney(transaction.savings.amount, transaction.savings.currency))}</span></div>
              <div class="modal-row"><span>Orden</span><span>${escapeHtml(transaction.orderId)}</span></div>
              <div class="modal-row"><span>Captura</span><span>${escapeHtml(transaction.captureId)}</span></div>
              <div class="modal-row"><span>Red</span><span>${isDemo ? 'DEMO · simulación' : 'PayPal Sandbox'}</span></div>
            </div>
            <div class="modal-actions">
              <button type="button" class="btn btn-primary" id="receipt-done" data-autofocus>Nueva transferencia</button>
              <button type="button" class="btn btn-ghost" id="receipt-activity">Ver actividad</button>
            </div>
            <p class="modal-secure">Nexus cubrió ${escapeHtml(fmtMoney(transaction.savings.amount, transaction.savings.currency))} de comisiones con liquidez del motor.</p>
          </div>
        </div>
      </div>`;

    const { dialog } = openModal(html);
    dialog.querySelector('#receipt-done').addEventListener('click', () => {
      closeModal();
      resetAfterPayment();
    });
    dialog.querySelector('#receipt-activity').addEventListener('click', () => {
      closeModal();
      document.getElementById('activity').scrollIntoView({ behavior: 'smooth' });
    });
  }

  function resetAfterPayment() {
    state.quote = null;
    els['quote-panel'].hidden = true;
    els['agent-empty'].hidden = false;
    setAgentEmpty('Ruta completada.', 'Configura un nuevo envío para volver a optimizar.');
    els['preview-receive'].textContent = '—';
    els['preview-rate'].textContent = 'La tasa óptima se calcula al optimizar';
    els['paypal-button-container'].replaceChildren();
    els['demo-paypal-btn'].hidden = true;
    setAgentState('idle', 'En espera');
    setTerminalMode('IDLE');
    els['agent-foot'].textContent = 'Listo para ejecutar';
    els['agent-latency'].textContent = '— ms';
    els['recipient-email'].value = '';
    resetTerminalIdle();
    loadStatus();
  }

  // ------------------------------------------------------------- dashboard

  async function loadDashboard({ manual = false } = {}) {
    if (manual) els['refresh-dashboard'].disabled = true;
    try {
      const data = await apiRequest('/api/dashboard?limit=12');
      state.dashboard = data;
      renderStats(data.totals);
      renderChart(data.series);
      renderCorridors(data.corridors || [], data.totals);
      renderLedger(data.transactions, data.totals);
      els['demo-data-note'].hidden = !(data.totals.demoCount > 0);
      if (manual) toast('Actividad actualizada', 'Ledger sincronizado con el servidor.', 'info');
    } catch (error) {
      if (!state.dashboard) {
        els['ledger-body'].replaceChildren();
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'ledger-empty';
        cell.textContent = `No se pudo cargar la actividad: ${error.message}`;
        row.appendChild(cell);
        els['ledger-body'].appendChild(row);
      }
      toast('No se pudo cargar la actividad', error.message, 'error');
    } finally {
      if (manual) els['refresh-dashboard'].disabled = false;
    }
  }

  function animateStat(node, target, formatter) {
    const value = Number(target) || 0;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      node.textContent = formatter(value);
      return;
    }
    const startedAt = performance.now();
    const duration = 750;

    function frame(now) {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      node.textContent = formatter(value * eased);
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function renderStats(totals) {
    animateStat(els['stat-count'], totals.count, (value) => nf(0).format(Math.round(value)));
    animateStat(els['stat-volume'], totals.volumeUsd, (value) =>
      `$${nf(totals.volumeUsd >= 1000 ? 0 : 2).format(value)}`,
    );
    animateStat(els['stat-savings'], totals.savingsUsd, (value) => `$${nf(2).format(value)}`);

    els['stat-volume'].title = fmtUsd(totals.volumeUsd);
    els['stat-savings'].title = fmtUsd(totals.savingsUsd);
    els['stat-savings-pct'].textContent = `${nf(2).format(totals.avgSavingsPct)}% promedio`;
    els['stat-count-sub'].textContent =
      totals.count > 0 && totals.demoCount === totals.count
        ? 'entorno demo · sin dinero real'
        : totals.demoCount > 0
          ? `${totals.demoCount} demo · ${Math.max(0, totals.count - totals.demoCount)} reales`
          : 'optimizadas';
  }

  function renderChart(series) {
    const chart = els['savings-chart'];
    chart.replaceChildren();

    if (!series || series.length === 0) {
      chart.textContent = 'Sin datos todavía.';
      return;
    }

    const total = series.reduce((sum, day) => sum + (Number(day.savingsUsd) || 0), 0);
    const max = Math.max(...series.map((day) => Number(day.savingsUsd) || 0), 1);
    const transfers = series.reduce((sum, day) => sum + (Number(day.count) || 0), 0);

    for (let index = 0; index < series.length; index += 1) {
      const day = series[index];
      const value = Number(day.savingsUsd) || 0;
      const height = value > 0 ? Math.max(4, Math.round((value / max) * 132)) : 3;
      const column = document.createElement('div');
      column.className = `chart-col${index === series.length - 1 ? ' is-today' : ''}`;
      column.title = `${day.date} · ${day.count} transferencias · ${fmtUsd(value)} absorbidos`;

      const valueLabel = document.createElement('span');
      valueLabel.className = 'chart-value';
      valueLabel.textContent = value > 0 ? `$${Math.round(value)}` : '';

      const bar = document.createElement('span');
      bar.className = 'chart-bar';
      bar.style.height = `${height}px`;

      const label = document.createElement('span');
      label.className = 'chart-label';
      label.textContent = day.label;

      column.append(valueLabel, bar, label);
      chart.appendChild(column);
    }

    els['chart-total'].textContent = `+$${nf(2).format(total)}`;
    els['chart-caption'].textContent = `${transfers} transferencias · 7 días`;
    chart.setAttribute('aria-label', `Ahorro absorbido por día: total ${fmtUsd(total)} en ${transfers} transferencias.`);
  }

  function renderCorridors(corridors, totals) {
    const list = els['corridor-list'];
    list.replaceChildren();
    els['corridor-count'].textContent = corridors.length ? `${corridors.length} rutas` : '—';

    if (!corridors.length) {
      const empty = document.createElement('li');
      empty.className = 'corridor-empty';
      empty.textContent = 'Aún sin corredores. Optimiza una transferencia para estrenar la ruta.';
      list.appendChild(empty);
      return;
    }

    const max = Math.max(...corridors.map((corridor) => Number(corridor.savingsUsd) || 0), 1);
    const totalSavings = Number(totals?.savingsUsd) || 0;

    for (const corridor of corridors.slice(0, 4)) {
      const savings = Number(corridor.savingsUsd) || 0;
      const row = document.createElement('li');
      row.className = 'corridor-row';

      const top = document.createElement('div');
      top.className = 'corridor-top';
      const label = document.createElement('span');
      label.className = 'corridor-code';
      label.textContent = String(corridor.label || '').replace('→', ' → ');
      const amount = document.createElement('strong');
      amount.textContent = `+${fmtUsd(savings)}`;
      top.append(label, amount);

      const bar = document.createElement('div');
      bar.className = 'corridor-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.max(6, Math.round((savings / max) * 100))}%`;
      bar.appendChild(fill);

      const meta = document.createElement('div');
      meta.className = 'corridor-meta';
      const count = document.createElement('span');
      count.textContent = `${corridor.count} ${corridor.count === 1 ? 'transferencia' : 'transferencias'}`;
      const share = document.createElement('span');
      share.textContent = `${nf(1).format(totalSavings > 0 ? (savings / totalSavings) * 100 : 0)}% del ahorro`;
      meta.append(count, share);

      row.append(top, bar, meta);
      list.appendChild(row);
    }
  }

  function renderLedger(transactions, totals) {
    const body = els['ledger-body'];
    body.replaceChildren();

    els['ledger-count'].textContent = `${totals.count} registros`;

    if (!transactions || transactions.length === 0) {
      const row = document.createElement('tr');
      const cell = document.createElement('td');
      cell.colSpan = 7;
      cell.className = 'ledger-empty';
      cell.textContent = 'Todavía no hay transferencias. Optimiza una para estrenar tu ledger.';
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    for (const tx of transactions) {
      const row = document.createElement('tr');
      row.title = tx.demo ? 'Registro semilla de demostración' : `Orden ${tx.orderId}`;

      const date = document.createElement('td');
      date.className = 'date-cell';
      date.textContent = fmtDate(tx.createdAt);

      const corridor = document.createElement('td');
      corridor.className = 'corridor-cell';
      corridor.appendChild(document.createTextNode(`${tx.corridor?.from || '?'} → ${tx.corridor?.to || '?'}`));
      const sub = document.createElement('small');
      sub.textContent = tx.demo ? 'sandbox · demo' : tx.mode || 'sandbox';
      corridor.appendChild(sub);

      const amount = document.createElement('td');
      amount.className = 'amount-cell';
      amount.textContent = fmtMoney(tx.amount, tx.sourceCurrency);

      const received = document.createElement('td');
      received.className = 'amount-cell';
      received.textContent = fmtUnit(tx.recipientAmount, tx.recipientCurrency);

      const fee = document.createElement('td');
      fee.className = 'amount-cell';
      fee.textContent = '$0.00';

      const savings = document.createElement('td');
      savings.className = 'savings-cell';
      savings.textContent = `+${fmtMoney(tx.savings?.usd ?? 0, 'USD')}`;

      const status = document.createElement('td');
      const pill = document.createElement('span');
      pill.className = `status-pill${tx.demo ? ' is-demo' : ''}`;
      pill.textContent = tx.demo ? 'demo' : statusLabel(tx.status);
      status.appendChild(pill);

      row.append(date, corridor, amount, received, fee, savings, status);
      body.appendChild(row);
    }
  }

  // ---------------------------------------------------------------- status

  async function loadStatus(manual = false) {
    if (state.statusInFlight) return;
    state.statusInFlight = true;

    try {
      const status = await apiRequest('/api/agent/status');
      state.status = status;
      applyStatus(status);
      if (manual) {
        toast('Motor actualizado', `${status.label} · ${status.strategy.yieldBps} bps de yield.`, 'info');
      }
    } catch (error) {
      els['engine-pill'].classList.add('is-offline');
      els['engine-pill-text'].textContent = 'API sin conexión';
      els['metric-yield'].textContent = '—';
      els['metric-liquidity'].textContent = '—';
      els['metric-latency'].textContent = '—';
      if (manual) toast('No se pudo consultar el motor', error.message, 'error');
    } finally {
      state.statusInFlight = false;
    }
  }

  function applyStatus(status) {
    const pill = els['engine-pill'];
    pill.classList.remove('is-warn', 'is-offline');

    let shortLabel = 'Simulación';
    if (status.engine === 'live') {
      shortLabel = 'Motor en vivo';
    } else if (status.engine === 'linked') {
      shortLabel = 'Puente Nexus';
      pill.classList.add('is-warn');
    } else if (status.engine === 'offline') {
      shortLabel = 'Modo simulación';
      pill.classList.add('is-offline');
    }

    els['engine-pill-text'].textContent = shortLabel;
    pill.title = `${status.label} · ${status.botUrl} · ${status.strategy.yieldBps} bps · ${status.latencyMs ?? '—'} ms · ${status.checkedAt}`;

    els['metric-yield'].textContent = `${status.strategy.yieldBps} bps`;
    els['metric-liquidity'].textContent = fmtUsdCompact(status.strategy.liquidityUsd);
    els['metric-latency'].textContent = status.latencyMs === null ? '— ms' : `${status.latencyMs} ms`;
    els['chip-engine'].textContent = status.engine === 'live' ? 'Motor en vivo' : status.engine === 'linked' ? 'Puente activo' : 'Simulación';
    els['how-yield'].textContent = `${status.strategy.yieldBps} bps`;
    els['how-depth'].textContent = fmtUsdCompact(status.strategy.liquidityUsd);
    els['terminal-bot-url'].textContent = status.botUrl;
  }

  // ----------------------------------------------------------------- modal

  function openModal(html) {
    closeModal();
    const root = els['modal-root'];
    root.innerHTML = html;
    const backdrop = root.firstElementChild;
    const dialog = backdrop?.querySelector('.modal');
    if (!dialog) return { dialog: null, close: closeModal };

    lastFocusedElement = document.activeElement;

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeModal();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = $$(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        dialog,
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onBackdropClick = (event) => {
      if (event.target === backdrop) closeModal();
    };

    backdrop.addEventListener('click', onBackdropClick);
    document.addEventListener('keydown', onKeyDown);
    $$('[data-close]', backdrop).forEach((button) => {
      button.addEventListener('click', closeModal);
    });

    modalCleanup = () => {
      document.removeEventListener('keydown', onKeyDown);
      backdrop.removeEventListener('click', onBackdropClick);
      root.innerHTML = '';
      if (lastFocusedElement && typeof lastFocusedElement.focus === 'function') {
        lastFocusedElement.focus();
      }
      lastFocusedElement = null;
    };

    requestAnimationFrame(() => {
      const target = dialog.querySelector('[data-autofocus]') || dialog.querySelector('button');
      if (target) target.focus();
    });

    return { dialog, close: closeModal };
  }

  function closeModal() {
    if (!modalCleanup) return;
    const cleanup = modalCleanup;
    modalCleanup = null;
    cleanup();
  }

  // ---------------------------------------------------------------- events

  function bindEvents() {
    els['transfer-form'].addEventListener('submit', handleOptimize);

    els.amount.addEventListener('input', scheduleFormEdit);
    els['recipient-email'].addEventListener('input', scheduleFormEdit);

    els['source-country'].addEventListener('change', () => {
      ensureDistinctDestination();
      onFormEdited();
    });
    els['destination-country'].addEventListener('change', () => {
      ensureDistinctDestination();
      onFormEdited();
    });

    $$('.quick-amount').forEach((button) => {
      button.addEventListener('click', () => {
        els.amount.value = button.dataset.amount;
        $$('.quick-amount').forEach((item) => item.classList.toggle('is-active', item === button));
        onFormEdited();
      });
    });

    els['swap-btn'].addEventListener('click', swapCountries);
    els['refresh-dashboard'].addEventListener('click', () => loadDashboard({ manual: true }));
    els['engine-pill'].addEventListener('click', () => loadStatus(true));

    els['quote-reset'].addEventListener('click', () => {
      clearQuote();
      els['agent-empty'].hidden = false;
      setAgentEmpty('Aún no hay una ruta activa.', 'Completa el formulario y el agente calculará la cobertura.');
      els.amount.focus();
    });

    els['demo-paypal-btn'].addEventListener('click', () => {
      const action = els['demo-paypal-btn'].dataset.action;
      if (action === 'retry-paypal' && state.quote) {
        setupPayPal(state.quote);
        return;
      }
      if (state.quote) openDemoCheckout(state.quote);
    });

    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) loadStatus();
    });
  }

  function scheduleFormEdit() {
    clearTimeout(editTimer);
    editTimer = setTimeout(() => onFormEdited(), 120);
  }

  function onFormEdited() {
    if (state.running) return;
    updateCurrencyUI();
    updateRoutePreview();
    if (state.quote) {
      clearQuote('La configuración cambió. Optimiza de nuevo para actualizar la ruta.');
    }
  }

  function ensureDistinctDestination() {
    if (els['source-country'].value !== els['destination-country'].value) return;
    const alternative = state.config?.countries?.find(
      (country) => country.receive && country.code !== els['source-country'].value,
    );
    if (alternative) els['destination-country'].value = alternative.code;
  }

  function swapCountries() {
    const source = currentCountry(els['source-country'].value);
    const destination = currentCountry(els['destination-country'].value);
    if (!source || !destination) return;
    if (!destination.send) {
      toast('Ese destino no admite envíos', 'Elige un país de destino que también pueda operar como origen.', 'info');
      return;
    }
    const newDestination = source.receive ? source.code : null;
    els['source-country'].value = destination.code;
    if (newDestination) els['destination-country'].value = newDestination;
    else ensureDistinctDestination();
    onFormEdited();
  }

  // start
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
