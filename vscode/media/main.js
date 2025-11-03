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
    const { localIP, udpPort, cmdUdpPort } = msg;
    if (!app.configure) app.configure = {};
    // Persist only local info (localIP and udpPort)
    if (app.$set) {
      if (localIP) app.$set(app.configure, 'localIP', localIP);
      if (udpPort != null) app.$set(app.configure, 'udpPort', udpPort);
    } else {
      if (localIP) app.configure.localIP = localIP;
      if (udpPort != null) app.configure.udpPort = udpPort;
    }
    // Do not touch remoteAddress/cmdUdpPort here
    // Reflect in UDP inputs (address=localIP, port=udpPort), connected=false by default
    for (const c of (app.connections || [])) {
      const inputs = c.inputs || c.dataInputs || c.inputsList || [];
      for (const input of inputs) {
        if (input && input.type === 'UDP') {
          if (app.$set) {
            if (localIP) app.$set(input, 'address', localIP);
            if (udpPort != null) app.$set(input, 'port', udpPort);
            if (input.connected === undefined) app.$set(input, 'connected', false);
          } else {
            if (localIP) input.address = localIP;
            if (udpPort != null) input.port = udpPort;
            if (input.connected === undefined) input.connected = false;
          }
        }
      }
    }
    // Ensure default disconnected state
    if (app.$set) {
      if (app.configure.remoteAddress === undefined) app.$set(app.configure, 'remoteAddress', '0.0.0.0');
      if (app.configure.cmdUdpPort === undefined) app.$set(app.configure, 'cmdUdpPort', 0);
    } else {
      if (app.configure.remoteAddress === undefined) app.configure.remoteAddress = '0.0.0.0';
      if (app.configure.cmdUdpPort === undefined) app.configure.cmdUdpPort = 0;
    }
    setAllUdpConnected(false);
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
        // Formato: CONNECTED:<IP_REMOTO>:<CMD_UDP_PORT>
        const parts = line.split(':');
        const closeIP = parts[1] || '';
        const closePort = Number(parts[2] || NaN);
        console.log("[UDP] DISCONNECTED do host:", closeIP, closePort);

        clearTimeout(app.handshake.timer);
        app.handshake.pending = false;

        // NÃO alterar remoteAddress aqui (regra pedida). Só marcar conectado.
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

  // Define destino remoto exclusivamente aqui
  this.configure.remoteAddress = host;
  this.configure.cmdUdpPort = port;

  // Conectado se ambos válidos
  const nowConnected = (this.configure.remoteAddress !== '0.0.0.0' && Number(this.configure.cmdUdpPort || 0) !== 0);
  setAllUdpConnected(nowConnected);

  // Solicita ao host efetivar a conexão e enviar handshake
  if (vscode) vscode.postMessage({ type: 'udp.connect', remoteAddress: host, cmdUdpPort: port });

  // Fecha modal
  this.creatingConnection = false;
  this.newConnectionAddress = "";
};

app.handleCancel = function () {
  // Tenta ler host:porta do campo do modal
  const parsed = parseHostPort(this.newConnectionAddress);

  // Decide alvo do cancel
  let host = this.configure.remoteAddress || '0.0.0.0';
  let port = Number(this.configure.cmdUdpPort || 0);

  // Se veio host:porta novo, atualiza estado para esse destino
  if (parsed) {
    host = parsed.host;
    port = parsed.port;
    // Envia DISCONNECT ao host/porta alvo
    if (vscode) {
      vscode.postMessage({ type: 'udp.disconnect', remoteAddress: host, cmdUdpPort: port });
    }
  }
  else{
    // Envia DISCONNECT ao host/porta alvo
    if (vscode) {
      vscode.postMessage({ type: 'udp.disconnect', remoteAddress: host, cmdUdpPort: port });
    }
    // Marca como desconectado e reseta destino
    setAllUdpConnected(false);
    this.configure.remoteAddress = '0.0.0.0';
    this.configure.cmdUdpPort = 0;
  }
  // Fecha modal e limpa input
  this.creatingConnection = false;
  this.newConnectionAddress = "";
};

