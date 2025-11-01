// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import * as dgram from 'dgram';

import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';

// ================== CONFIG ==================
const CONFIG_NS = 'lasecplot';
const CFG_UDP_ADDRESS = 'udpAddress';
const CFG_UDP_PORT = 'udpPort';
const CFG_CMD_UDP_PORT = 'cmdUdpPort';

// ================== TIPOS AUX ==================
type PortInfoLite = {
  path: string;              // COMx ou /dev/tty...
  friendlyName?: string;     // texto útil para exibir
  manufacturer?: string;
  pnpId?: string;
  serialNumber?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
  deviceLocation?: string;
  devicePath?: string;       // \Device\Serial0 (no Windows / Registro)
  isVirtual?: boolean;       // heurística
  _source?: string;          // debug: SERIALCOMM, serialport, merge
};

// ================== ESTADO GLOBAL ==================
let serials: Record<string, SerialPort> = {};
let udpServer: dgram.Socket | null = null;
let currentPanel: vscode.WebviewPanel | null = null;
const _disposables: vscode.Disposable[] = [];
let statusBarIcon: vscode.StatusBarItem;

// ================== FUNÇÕES DE CONFIG ==================
function getConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const udpAddress = cfg.get<string>(CFG_UDP_ADDRESS, '');
  const udpPort = cfg.get<number>(CFG_UDP_PORT, 47269);
  const cmdUdpPort = cfg.get<number>(CFG_CMD_UDP_PORT, 47268);
  return { cfg, udpAddress, udpPort, cmdUdpPort };
}

function updateStatusBar(udpPort: number, cmdUdpPort: number) {
  if (!statusBarIcon) return;
  statusBarIcon.text = `$(graph-line) LasecPlot`;
  statusBarIcon.tooltip = `UDP-Send: ${cmdUdpPort} • UDP-Recive: ${udpPort}`;
  statusBarIcon.show();
}

function bindUdpServer(udpPort: number, cmdUdpPort: number) {
  if (udpServer) {
    try { udpServer.close(); } catch { /* ignore */ }
    udpServer = null;
  }
  udpServer = dgram.createSocket('udp4');
  udpServer.bind(udpPort);

  udpServer.on('message', (msg: Buffer) => {
    currentPanel?.webview.postMessage({
      data: msg.toString(),
      fromSerial: false,
      timestamp: Date.now()
    });
  });

  udpServer.on('error', (err) => console.error('[UDP] server error:', err));
  updateStatusBar(udpPort, cmdUdpPort);
}

async function saveAddressPort(address: string, port: number) {
  const { cfg, udpPort, cmdUdpPort } = getConfig();
  await cfg.update(CFG_UDP_ADDRESS, address, vscode.ConfigurationTarget.Global);
  if (udpPort !== port) {
    await cfg.update(CFG_UDP_PORT, port, vscode.ConfigurationTarget.Global);
    bindUdpServer(port, cmdUdpPort);
  } else {
    updateStatusBar(udpPort, cmdUdpPort);
  }
}

async function saveCmdPort(port: number) {
  const { cfg, udpPort, cmdUdpPort } = getConfig();
  if (cmdUdpPort !== port) {
    await cfg.update(CFG_CMD_UDP_PORT, port, vscode.ConfigurationTarget.Global);
    updateStatusBar(udpPort, port);
  }
}

// ================== ATIVAÇÃO ==================
export function activate(context: vscode.ExtensionContext) {
  statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarIcon.command = 'lasecplot.start';
  context.subscriptions.push(statusBarIcon);

  context.subscriptions.push(
    vscode.commands.registerCommand('lasecplot.start', () => {
      const { udpAddress, udpPort, cmdUdpPort } = getConfig();
      bindUdpServer(udpPort, cmdUdpPort);

      const column: vscode.ViewColumn =
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

      if (currentPanel) {
        currentPanel.reveal(column, false);
        return;
      }

      const panel = vscode.window.createWebviewPanel(
        'lasecplot',
        'LasecPlot',
        column,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
          retainContextWhenHidden: true,
          enableCommandUris: true,
        }
      );
      currentPanel = panel;

      fs.readFile(path.join(context.extensionPath, 'media', 'index.html'), (err, data) => {
        if (err) { console.error(err); return; }
        let rawHTML = data.toString();

        // Reescrever src/href para URIs do webview
        const srcList = rawHTML.match(/src="(.*?)"/g) ?? [];
        const hrefList = rawHTML.match(/href="(.*?)"/g) ?? [];
        for (const attr of [...srcList, ...hrefList]) {
          const url = attr.split('"')[1];
          const extensionURI = vscode.Uri.joinPath(context.extensionUri, "./media/" + url);
          const webURI = panel.webview.asWebviewUri(extensionURI);
          const toReplace = attr.replace(url, webURI.toString());
          rawHTML = rawHTML.replace(attr, toReplace);
        }

        // Força estilo dark se existir marcador
        const lasecplotStyle = rawHTML.match(/(.*)_lasecplot_default_color_style(.*)/g);
        if (lasecplotStyle != null) {
          rawHTML = rawHTML.replace(lasecplotStyle.toString(), 'var _lasecplot_default_color_style = "dark";');
        }

        panel.webview.html = rawHTML;

        // Envia config inicial
        panel.webview.postMessage({
          type: 'initConfig',
          udpAddress,
          udpPort,
          cmdUdpPort,
        });
      });

      panel.onDidDispose(() => {
        if (udpServer) {
          try { udpServer.close(); } catch { /* ignore */ }
          udpServer = null;
        }
        while (_disposables.length) {
          const x = _disposables.pop();
          if (x) x.dispose();
        }
        _disposables.length = 0;
        for (const s in serials) {
          try { serials[s].close(); } catch { /* ignore */ }
          (serials as any)[s] = null;
        }
        serials = {};
        currentPanel = null;
      }, null, _disposables);

      panel.webview.onDidReceiveMessage(async (message) => {
        // salvar host/port de dados
        if (message?.type === 'saveAddressPort') {
          const host = String(message.host || '').trim();
          const portNum = Number(message.port);
          if (host && Number.isFinite(portNum)) {
            await saveAddressPort(host, portNum);
          }
          return;
        }

        // salvar cmd port
        if (message?.type === 'saveCmdPort') {
          const portNum = Number(message.port);
          if (Number.isFinite(portNum)) {
            await saveCmdPort(portNum);
          }
          return;
        }

        // enviar payload para endereço/porta de comando
        if ('data' in message) {
          const { udpAddress: addr, cmdUdpPort: currentCmdPort } = getConfig();
          const buf: Buffer = Buffer.isBuffer(message.data)
            ? message.data
            : Buffer.from(String(message.data));
          const udpClient = dgram.createSocket('udp4');
          udpClient.send(buf, 0, buf.length, currentCmdPort, addr || '127.0.0.1', () => {
            udpClient.close();
          });
          return;
        }

        // comandos gerais
        if ('cmd' in message) {
          runCmd(message);
          return;
        }
      }, null, _disposables);
    })
  );

  const { udpPort, cmdUdpPort } = getConfig();
  updateStatusBar(udpPort, cmdUdpPort);
  statusBarIcon.show();
}

// ================== COMANDOS / SERIAL ==================
function runCmd(msg: any) {
  const id: string = ('id' in msg) ? msg.id : '';

  if (msg.cmd === 'listSerialPorts') {
    listSerialPortsMerged().then((ports) => {
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: ports });
    }).catch(async (err) => {
      console.warn('[serial] merged list failed, fallback SerialPort.list():', err);
      try {
        const base = await SerialPort.list();
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: base });
      } catch (e) {
        console.error('[serial] total list failure:', e);
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: [] });
      }
    });
    return;
  }
  else if (msg.cmd === 'connectSerialPort') {
    if (serials[id]) {
      try { serials[id].close(); } catch { /* ignore */ }
      delete serials[id];
    }

    const requestedPath: string = String(msg.port || '');
    const baud: number = Number(msg.baud || 115200);

    const openPath = normalizeWindowsPathForOpen(requestedPath);

    const sp = new SerialPort({ path: openPath, baudRate: baud });
    serials[id] = sp;

    sp.on('open', () => {
      console.log('[serial] open', openPath);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortConnect', port: requestedPath, baud });
    });
    sp.on('error', (err) => {
      console.log('[serial] error', err);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: requestedPath, baud });
    });
    sp.on('close', () => {
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortDisconnect' });
    });

    const parser = sp.pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (data: Buffer | string) => {
      currentPanel?.webview.postMessage({
        id,
        data: data.toString(),
        fromSerial: true,
        timestamp: Date.now()
      });
    });
    return;
  }
  else if (msg.cmd === 'sendToSerial') {
    serials[id]?.write(String(msg.text ?? ''));
    return;
  }
  else if (msg.cmd === 'disconnectSerialPort') {
    try { serials[id]?.close(); } catch { /* ignore */ }
    delete serials[id];
    return;
  }
  else if (msg.cmd === 'saveFile') {
    try {
      exportDataWithConfirmation(path.join(msg.file.name), { JSON: ['json'] }, msg.file.content);
    } catch (error: any) {
      void vscode.window.showErrorMessage("Couldn't write file: " + error);
    }
    return;
  }
}

// ================== SAVE DIALOG ==================
function exportDataWithConfirmation(fileName: string, filters: { [name: string]: string[] }, data: string): void {
  void vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(fileName),
    filters,
  }).then((uri: vscode.Uri | undefined) => {
    if (uri) {
      const value = uri.fsPath;
      fs.writeFile(value, data, (error: any) => {
        if (error) {
          void vscode.window.showErrorMessage('Could not write to file: ' + value + ': ' + error.message);
        } else {
          void vscode.window.showInformationMessage('Saved ' + value);
        }
      });
    }
  });
}

// ================== LISTA DE PORTAS (MERGE) ==================
async function listSerialPortsMerged(): Promise<PortInfoLite[]> {
  // Base do serialport (existe em todas as plataformas)
  const spList = await SerialPort.list();

  if (os.platform() !== 'win32') {
    // Fora do Windows, retorna direto
    return sortPorts(spList.map(mapFromSerialport));
  }

  // No Windows: ler Registro e mesclar
  const regList = await listSerialPortsFromRegistry();
  const byKey = new Map<string, PortInfoLite>();

  // Começa pelo Registro (prioriza o que o SO diz)
  for (const r of regList) {
    const k = String(r.path || '').toUpperCase();
    if (!k) continue;
    byKey.set(k, { ...r, _source: 'SERIALCOMM' });
  }

  // Enriquecer/mesclar com SerialPort.list()
  for (const p of spList) {
    const pp = mapFromSerialport(p);
    const k = String(pp.path || '').toUpperCase();
    if (!k) continue;
    if (byKey.has(k)) {
      const merged = { ...pp, ...byKey.get(k) };
      merged.isVirtual = inferVirtualFromStrings(
        merged.friendlyName, merged.pnpId, merged.manufacturer, merged.devicePath
      );
      merged._source = 'SERIALCOMM+serialport';
      byKey.set(k, merged);
    } else {
      byKey.set(k, { ...pp, _source: 'serialport' });
    }
  }

  return sortPorts(Array.from(byKey.values()));
}

function mapFromSerialport(p: any): PortInfoLite {
  return {
    path: p.path,
    friendlyName: p.friendlyName ?? p.path,
    manufacturer: p.manufacturer,
    pnpId: p.pnpId,
    serialNumber: p.serialNumber,
    locationId: p.locationId,
    productId: p.productId,
    vendorId: p.vendorId
  };
}

function sortPorts(arr: PortInfoLite[]): PortInfoLite[] {
  const out = [...arr];
  out.sort((a, b) => {
    const na = parseInt(String(a.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    const nb = parseInt(String(b.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    return na - nb;
  });
  return out;
}

// ================== WINDOWS: Registro SERIALCOMM ==================
async function listSerialPortsFromRegistry(): Promise<PortInfoLite[]> {
  const out: PortInfoLite[] = [];
  try {
    const args = ['query', 'HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM'];
    const stdout = await execReg(args);
    const lines = String(stdout || '').split(/\r?\n/);

    for (const line of lines) {
      if (!/REG_SZ/i.test(line)) continue;
      // Formato: "<Nome>   REG_SZ   <Dados>"
      const parts = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
      if (parts.length >= 3) {
        const devicePath = parts[0];
        const dataCol = (parts[2] || '').trim(); // geralmente "COMx" ou "CNCA0" etc.

        // Só COMx é abrível diretamente (outros nomes são aliases; listamos mesmo assim)
        if (/^COM\d+$/i.test(dataCol)) {
          out.push({
            path: dataCol.toUpperCase(),
            friendlyName: devicePath,
            devicePath
          });
        } else {
          // Mantemos para visualização (e permitir abrir via \\.\NOME se usuário quiser)
          out.push({
            path: dataCol, // ex.: "CNCA0"
            friendlyName: devicePath,
            devicePath
          });
        }
      }
    }
  } catch (e) {
    console.warn('[serial] registry read failed:', e);
  }

  // de-dup por path
  const uniq = new Map<string, PortInfoLite>();
  for (const p of out) uniq.set(String(p.path || '').toUpperCase(), p);
  return Array.from(uniq.values());
}

function execReg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err);
      resolve(String(stdout || ''));
    });
  });
}

function inferVirtualFromStrings(...fields: (string | undefined)[]): boolean {
  const hay = fields.filter(Boolean).join(' ').toLowerCase();
  const hints = ['com0com', 'virtual', 'null-modem', 'emulator', 'loopback'];
  return hints.some(h => hay.includes(h));
}

// ================== WINDOWS: Normalização para abrir ==================
function normalizeWindowsPathForOpen(requested: string): string {
  if (os.platform() !== 'win32') return requested;

  const port = String(requested || '').trim();
  if (!port) return port;

  // COM1..COM9: pode abrir como está.
  const m = /^COM(\d+)$/i.exec(port);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 9) return `COM${n}`;
    // COM10+ precisa \\.\COM10
    return `\\\\.\\${port}`;
  }

  // Qualquer outro nome (ex.: CNCA0, dispositivos com nome extenso) => \\.\NOME
  if (!port.startsWith('\\\\.\\')) {
    return `\\\\.\\${port}`;
  }
  return port;
}

// ================== DESATIVAÇÃO ==================
export function deactivate() {
  try { udpServer?.close(); } catch { /* ignore */ }
  for (const k in serials) {
    try { serials[k].close(); } catch { /* ignore */ }
  }
}
