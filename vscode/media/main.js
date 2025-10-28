// main.js — LasecPlot (webview)
// - input.address / input.port mostram IP/porta LOCAIS (udpAddress/udpPort)
// - newConnectionAddress é o IP:PORTA REMOTO (remoteAddress/cmdUdpPort)
// - Handshake UDP: envia "CONNECT:<IP_LOCAL>:<UDP_PORT>" para REMOTO:CMD_UDP_PORT
//   e aguarda "OK:<IP_REMOTO>:<CMD_UDP_PORT>" para marcar connected.

var vscode = null;
if ("acquireVsCodeApi" in window) vscode = acquireVsCodeApi();

var app = initializeAppView();

/* ======================= CONFIG & STATE ======================= */

if (!app.configure) app.configure = {};
if (app.$set) {
  if (app.configure.udpAddress === undefined) app.$set(app.configure, 'udpAddress', '');
  if (app.configure.udpPort === undefined) app.$set(app.configure, 'udpPort', null);
  if (app.configure.remoteAddress === undefined) app.$set(app.configure, 'remoteAddress', '');
  if (app.configure.cmdUdpPort === undefined) app.$set(app.configure, 'cmdUdpPort', null);
} else {
  app.configure.udpAddress = app.configure.udpAddress || '';
  app.configure.udpPort = app.configure.udpPort || null;
  app.configure.remoteAddress = app.configure.remoteAddress || '';
  app.configure.cmdUdpPort = app.configure.cmdUdpPort || null;
}

// Estado de handshake
app.handshake = {
  pending: false,
  timer: null,
  timeoutMs: 5000,
  expected: { remoteHost: '', cmdPort: null }
};

function parseHostPort(addr) {
  const m = String(addr || "").match(/^\s*(\[.*\]|[^:]+):(\d+)\s*$/);
  if (!m) return null;
  let host = m[1].replace(/^\[|\]$/g, "");
  let port = parseInt(m[2], 10);
  return { host, port };
}

/* ======================= Persistência ======================= */

function persistLocalUdp(address, port) {
  if (vscode) {
    const prev = (vscode.getState && vscode.getState()) || {};
    vscode.setState({ ...prev, udpAddress: address, udpPort: port });
    vscode.postMessage({ type: 'saveAddressPort', host: address, port });
  }
  try {
    localStorage.setItem('lasecplot.udpAddress', address || '');
    localStorage.setItem('lasecplot.udpPort', String(port));
  } catch (_) { }
}

function persistRemoteCmd(address, port) {
  if (vscode) {
    const prev = (vscode.getState && vscode.getState()) || {};
    vscode.setState({ ...prev, remoteAddress: address, cmdUdpPort: port });
    vscode.postMessage({ type: 'saveRemoteAddress', host: address });
    vscode.postMessage({ type: 'saveCmdPort', port });
  }
  try {
    localStorage.setItem('lasecplot.remoteAddress', address || '');
    localStorage.setItem('lasecplot.cmdUdpPort', String(port));
  } catch (_) { }
}

/* ======================= Restauração ======================= */

app.loadStoredConfig = function () {
  let st = {};
  if (vscode && vscode.getState) st = vscode.getState() || {};

  let udpAddress = st.udpAddress ?? '';
  let udpPort = (st.udpPort != null) ? Number(st.udpPort) : null;
  let remoteAddress = st.remoteAddress ?? '';
  let cmdUdpPort = (st.cmdUdpPort != null) ? Number(st.cmdUdpPort) : null;

  try {
    if (!udpAddress) udpAddress = localStorage.getItem('lasecplot.udpAddress') || '';
    if (udpPort == null) {
      const p = localStorage.getItem('lasecplot.udpPort');
      if (p != null && p !== '' && !Number.isNaN(Number(p))) udpPort = Number(p);
    }
    if (!remoteAddress) remoteAddress = localStorage.getItem('lasecplot.remoteAddress') || '';
    if (cmdUdpPort == null) {
      const q = localStorage.getItem('lasecplot.cmdUdpPort');
      if (q != null && q !== '' && !Number.isNaN(Number(q))) cmdUdpPort = Number(q);
    }
  } catch (_) { }

  if (app.$set) {
    app.$set(app.configure, 'udpAddress', udpAddress || '');
    app.$set(app.configure, 'udpPort', udpPort ?? null);
    app.$set(app.configure, 'remoteAddress', remoteAddress || '');
    app.$set(app.configure, 'cmdUdpPort', cmdUdpPort ?? null);
  } else {
    app.configure.udpAddress = udpAddress || '';
    app.configure.udpPort = udpPort ?? null;
    app.configure.remoteAddress = remoteAddress || '';
    app.configure.cmdUdpPort = cmdUdpPort ?? null;
  }

  // Reflete na UI (input UDP mostra IP/porta locais)
  for (const c of (app.connections || [])) {
    const inputs = c.inputs || c.dataInputs || c.inputsList || [];
    for (const input of inputs) {
      if (input && input.type === 'UDP') {
        if (app.$set) {
          if (udpAddress) app.$set(input, 'address', udpAddress);
          if (udpPort != null) app.$set(input, 'port', udpPort);
        } else {
          if (udpAddress) input.address = udpAddress;
          if (udpPort != null) input.port = udpPort;
        }
      }
    }
  }
};

/* ======================= Conectar (REMOTO) ======================= */

app.createConnection = function () {
  const parsed = parseHostPort(this.newConnectionAddress);
  if (!parsed) {
    alert("Use o formato host:porta (ex.: 192.168.0.50:47268) — este é o destino REMOTO de comandos.");
    return;
  }
  const { host, port } = parsed;

  // Atualiza config remota + persiste
  if (this.$set) {
    this.$set(this.configure, 'remoteAddress', host);
    this.$set(this.configure, 'cmdUdpPort', port);
  } else {
    this.configure.remoteAddress = host;
    this.configure.cmdUdpPort = port;
  }
  persistRemoteCmd(host, port);

  // Envia CONNECT:<IP_LOCAL>:<UDP_PORT> para REMOTO:CMD_UDP_PORT
  const localIP = this.configure.udpAddress || '127.0.0.1';
  const localPort = Number(this.configure.udpPort || 0);
  const payload = `CONNECT:${localIP}:${localPort}`;
  if (vscode) {
    vscode.postMessage({ data: payload });
  }

  // Marca "connecting": zera connected e inicia timeout
  for (const c of (this.connections || [])) {
    const inputs = c.inputs || c.dataInputs || c.inputsList || [];
    for (const input of inputs) {
      if (input && input.type === 'UDP') {
        if (this.$set) this.$set(input, 'connected', false);
        else input.connected = false;
      }
    }
  }

  clearTimeout(app.handshake.timer);
  app.handshake.expected = { remoteHost: host, cmdPort: port };
  app.handshake.pending = true;
  app.handshake.timer = setTimeout(() => {
    app.handshake.pending = false;
    // opcional: feedback na UI
    console.warn("Handshake timeout: não recebemos OK do remoto.");
  }, app.handshake.timeoutMs);

  // Fecha modal
  this.creatingConnection = false;
  this.newConnectionAddress = "";
};

/* =================== Recepção do Host/Servidor =================== */

window.addEventListener('message', (event) => {
  const msg = event.data || {};

  // Config inicial do host
  if (msg.type === 'initConfig') {
    const udpAddress = msg.udpAddress || '';
    const udpPort = (msg.udpPort != null) ? Number(msg.udpPort) : null;
    const remoteAddress = msg.remoteAddress || app.configure.remoteAddress || '';
    const cmdUdpPort = (msg.cmdUdpPort != null)
      ? Number(msg.cmdUdpPort)
      : (app.configure.cmdUdpPort != null ? Number(app.configure.cmdUdpPort) : null);

    if (app.$set) {
      app.$set(app.configure, 'udpAddress', udpAddress || '');
      app.$set(app.configure, 'udpPort', udpPort ?? null);
      app.$set(app.configure, 'remoteAddress', remoteAddress || '');
      app.$set(app.configure, 'cmdUdpPort', cmdUdpPort ?? null);
    } else {
      app.configure.udpAddress = udpAddress || '';
      app.configure.udpPort = udpPort ?? null;
      app.configure.remoteAddress = remoteAddress || '';
      app.configure.cmdUdpPort = cmdUdpPort ?? null;
    }

    // Reflete no input UDP local
    for (const c of (app.connections || [])) {
      const inputs = c.inputs || c.dataInputs || c.inputsList || [];
      for (const input of inputs) {
        if (input && input.type === 'UDP') {
          if (app.$set) {
            if (udpAddress) app.$set(input, 'address', udpAddress);
            if (udpPort != null) app.$set(input, 'port', udpPort);
          } else {
            if (udpAddress) input.address = udpAddress;
            if (udpPort != null) input.port = udpPort;
          }
        }
      }
    }

    persistLocalUdp(udpAddress || '', udpPort ?? null);
    if (remoteAddress || cmdUdpPort != null) {
      persistRemoteCmd(remoteAddress || '', cmdUdpPort ?? null);
    }
    return;
  }

  // Dados vindos do host (UDP -> extensão -> webview)
  if (typeof msg.data === 'string') {
    // Verifica handshake OK
    const lines = msg.data.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith('OK:')) {
        // Formato esperado: OK:<IP_REMOTO>:<CMD_UDP_PORT>
        const parts = line.split(':');
        const okIP = parts[1] || '';
        const okPort = Number(parts[2] || NaN);

        if (app.handshake.pending) {
          const exp = app.handshake.expected;
          // Se quiser validar IP/porta, pode comparar com exp
          // Aqui aceitamos qualquer OK e marcamos como connected
          clearTimeout(app.handshake.timer);
          app.handshake.pending = false;

          for (const c of (app.connections || [])) {
            const inputs = c.inputs || c.dataInputs || c.inputsList || [];
            for (const input of inputs) {
              if (input && input.type === 'UDP') {
                if (app.$set) app.$set(input, 'connected', true);
                else input.connected = true;
              }
            }
          }
        }
      }
    }
  }
});

/* =================== Timers / Conexões =================== */

app.loadStoredConfig();

setInterval(updateView, 1000 / widgetFPS);

if (vscode) {
  let conn = new ConnectionLasecPlotVSCode();
  conn.connect();
  app.connections.push(conn);
} else {
  let conn = new ConnectionLasecPlotWebsocket();
  let addr = window.location.hostname;
  let port = window.location.port;
  conn.connect(addr, port);
  app.connections.push(conn);

  let params = new URLSearchParams(window.location.search);
  let layout = params.get("layout");
  if (layout) {
    fetch(layout).then(res => res.blob()).then(blob => {
      importLayoutJSON({ target: { files: [blob] } });
    });
  }
}

setInterval(() => {
  for (let conn of app.connections) {
    conn.updateCMDList();
  }
}, 3000);