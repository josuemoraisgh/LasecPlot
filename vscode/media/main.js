// main.js — LasecPlot (webview)
// Mantém o fluxo original, com ajustes:
// 1) configure.remoteAddress só muda quando createConnection() é acionado com host:porta válidos.
// 2) initConfig não sobrescreve remoteAddress.
// 3) Handshake CONNECTED/DISCONNECTED só alterna "connected" dos inputs UDP.
// 4) Persistência (vscode.setState/localStorage) e logs para depurar.

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
  try {
    if (vscode) {
      const prev = (vscode.getState && vscode.getState()) || {};
      vscode.setState({ ...prev, udpAddress: address, udpPort: port });
      vscode.postMessage({ type: 'saveAddressPort', host: address, port });
    }
    localStorage.setItem('lasecplot.udpAddress', address || '');
    localStorage.setItem('lasecplot.udpPort', String(port));
  } catch (_) { /* ignore */ }
}

function persistRemoteCmd(address, port) {
  try {
    if (vscode) {
      const prev = (vscode.getState && vscode.getState()) || {};
      vscode.setState({ ...prev, remoteAddress: address, cmdUdpPort: port });
      // Mantemos compat com seus handlers no host
      vscode.postMessage({ type: 'saveRemoteAddress', host: address });
      vscode.postMessage({ type: 'saveCmdPort', port });
    }
    localStorage.setItem('lasecplot.remoteAddress', address || '');
    localStorage.setItem('lasecplot.cmdUdpPort', String(port));
  } catch (_) { /* ignore */ }
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
  } catch (_) { /* ignore */ }

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

  // refletir nos inputs UDP
  for (const c of (app.connections || [])) {
    const inputs = c.inputs || c.dataInputs || c.inputsList || [];
    for (const input of inputs) {
      if (input && input.type === 'UDP') {
        if (app.$set) {
          if (udpAddress) app.$set(input, 'address', udpAddress);
          if (udpPort != null) app.$set(input, 'port', udpPort);
          if (input.connected === undefined) app.$set(input, 'connected', false);
        } else {
          if (udpAddress) input.address = udpAddress;
          if (udpPort != null) input.port = udpPort;
          if (input.connected === undefined) input.connected = false;
        }
      }
    }
  }
};

/* ======================= Conectar (REMOTO) ======================= */

app.createConnection = function () {
  // Campo de entrada no modal deve estar em this.newConnectionAddress (host:porta)
  const parsed = parseHostPort(this.newConnectionAddress);
  if (!parsed) {
    alert("Use o formato host:porta (ex.: 192.168.0.50:47268) — este é o destino REMOTO de comandos.");
    return;
  }
  const { host, port } = parsed;

  // Atualiza remoteAddress/cmdUdpPort SOMENTE aqui
  if (this.$set) {
    this.$set(this.configure, 'remoteAddress', host);
    this.$set(this.configure, 'cmdUdpPort', port);
  } else {
    this.configure.remoteAddress = host;
    this.configure.cmdUdpPort = port;
  }
  persistRemoteCmd(host, port);

  // Envia CONNECT:<IP_LOCAL>:<UDP_PORT> ao remoto (cmdUdpPort)
  const localIP = this.configure.udpAddress || '127.0.0.1';
  const localPort = Number(this.configure.udpPort || 0);
  const payload = `CONNECT:${localIP}:${localPort}`;
  console.log("[UDP] sending handshake:", payload, "to", host, ":", port);
  if (vscode) vscode.postMessage({ data: payload });

  // Enquanto aguarda, marca todos os UDP como "desconectados"
  for (const c of (this.connections || [])) {
    const inputs = c.inputs || c.dataInputs || c.inputsList || [];
    for (const input of inputs) {
      if (input && input.type === 'UDP') {
        if (this.$set) this.$set(input, 'connected', false);
        else input.connected = false;
      }
    }
  }

  // Cancela a criação de conexão e envia DISCONNECT:<LOCAL_IP>:<UDP_PORT>
  app.cancelConnection = function () {
    // fecha o modal
    this.creatingConnection = false;

    // marca todos os inputs UDP como desconectados
    setAllUdpConnected(false);

    // monta DISCONNECT:<LOCAL_IP>:<UDP_PORT>
    const localIP = this.configure.udpAddress || '127.0.0.1';
    const localPort = Number(this.configure.udpPort || 0);
    const payload = `DISCONNECT:${localIP}:${localPort}`;

    console.log(
      "[UDP] sending disconnect:",
      payload,
      "to",
      this.configure.remoteAddress,
      ":",
      this.configure.cmdUdpPort
    );

    // envia via extensão (host) para o destino remoto
    if (vscode) vscode.postMessage({ data: payload });

    // limpa estado de handshake
    clearTimeout(app.handshake.timer);
    app.handshake.pending = false;
    app.handshake.expected = { remoteHost: '', cmdPort: null };
  };

  clearTimeout(app.handshake.timer);
  app.handshake.expected = { remoteHost: host, cmdPort: port };
  app.handshake.pending = true;
  app.handshake.timer = setTimeout(() => {
    app.handshake.pending = false;
    console.warn("Handshake timeout: não recebemos OK do remoto.");
  }, app.handshake.timeoutMs);

  // Fecha modal
  this.creatingConnection = false;
  this.newConnectionAddress = "";
};

/* ============ Utilitário: marcar conexão UDP nos inputs ============ */
function setAllUdpConnected(flag) {
  for (const c of (app.connections || [])) {
    const inputs = c.inputs || c.dataInputs || c.inputsList || [];
    for (const input of inputs) {
      if (input && input.type === 'UDP') {
        if (app.$set) app.$set(input, 'connected', !!flag);
        else input.connected = !!flag;
      }
    }
  }
}

/* =================== Recepção do Host/Servidor =================== */

window.addEventListener('message', (event) => {
  const msg = event.data || {};

  // Config inicial — NÃO sobrescrever remoteAddress
  if (msg.type === 'initConfig') {
    const udpAddress = msg.udpAddress || '';
    const udpPort = (msg.udpPort != null) ? Number(msg.udpPort) : null;
    const cmdUdpPort = (msg.cmdUdpPort != null)
      ? Number(msg.cmdUdpPort)
      : (app.configure.cmdUdpPort != null ? Number(app.configure.cmdUdpPort) : null);

    // Atualiza apenas os campos locais
    if (app.$set) {
      app.$set(app.configure, 'udpAddress', udpAddress || '');
      app.$set(app.configure, 'udpPort', udpPort ?? null);
      // remoteAddress: mantido conforme regra solicitada
      app.$set(app.configure, 'cmdUdpPort', cmdUdpPort ?? null);
    } else {
      app.configure.udpAddress = udpAddress || '';
      app.configure.udpPort = udpPort ?? null;
      // remoteAddress: mantido
      app.configure.cmdUdpPort = cmdUdpPort ?? null;
    }

    // Reflete nos inputs UDP
    for (const c of (app.connections || [])) {
      const inputs = c.inputs || c.dataInputs || c.inputsList || [];
      for (const input of inputs) {
        if (input && input.type === 'UDP') {
          if (app.$set) {
            if (udpAddress) app.$set(input, 'address', udpAddress);
            if (udpPort != null) app.$set(input, 'port', udpPort);
            if (input.connected === undefined) app.$set(input, 'connected', false);
          } else {
            if (udpAddress) input.address = udpAddress;
            if (udpPort != null) input.port = udpPort;
            if (input.connected === undefined) input.connected = false;
          }
        }
      }
    }

    persistLocalUdp(udpAddress || '', udpPort ?? null);
    // remoteAddress fica como já estava (somente createConnection altera)
    if (cmdUdpPort != null) {
      // manter cmdUdpPort persistido caso venha do host
      persistRemoteCmd(app.configure.remoteAddress || '', cmdUdpPort);
    }
    return;
  }

  // Dados do host (inclui handshake textual via UDP repassado pela extensão)
  if (typeof msg.data === 'string') {
    const lines = msg.data.split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;

      // Handshake OK
      if (line.startsWith('CONNECTED:')) {
        // Formato: CONNECTED:<IP_REMOTO>:<CMD_UDP_PORT>
        const parts = line.split(':');
        const okIP = parts[1] || '';
        const okPort = Number(parts[2] || NaN);
        console.log("[UDP] CONNECTED do host:", okIP, okPort);

        clearTimeout(app.handshake.timer);
        app.handshake.pending = false;

        // NÃO alterar remoteAddress aqui (regra pedida). Só marcar conectado.
        setAllUdpConnected(true);
        continue;
      }

      // Desconectado
      if (line.startsWith('DISCONNECTED:')) {
        console.log("[UDP] DISCONNECTED do host:", line);
        setAllUdpConnected(false);
        continue;
      }
    }
  }
});

/* =================== Timers / Conexões =================== */

app.loadStoredConfig();

// Atualização de view (mantém seu ritmo original)
setInterval(updateView, 1000 / widgetFPS);

// Conexões: VSCode vs Websocket
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

// Atualiza lista de comandos periodicamente (comportamento original)
setInterval(() => {
  for (let conn of app.connections) {
    conn.updateCMDList();
  }
}, 3000);
