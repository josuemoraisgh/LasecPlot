// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';

import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
import * as dgram from 'dgram';

// ================== CONFIG ==================
const CONFIG_NS = 'lasecplot';
const CFG_UDP_ADDRESS = 'udpAddress';
const CFG_UDP_PORT = 'udpPort';
const CFG_CMD_UDP_PORT = 'cmdUdpPort';
const CFG_DEBUG_PORTS = 'debugPorts';

// ================== TIPO LOCAL PARA PORTAS ==================
type LPort = {
  path: string;            // COMx ou nome bruto do SERIALCOMM (CNCA0/CNCB0/etc.)
  friendlyName?: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  locationId?: string;
  pnpId?: string;
  devicePath?: string;     // \Device\Serial0 etc.
  isVirtual?: boolean;
  source?: string;         // 'serialport' | 'SERIALCOMM' | 'RAW'
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
  const debugPorts = cfg.get<boolean>(CFG_DEBUG_PORTS, false);
  return { cfg, udpAddress, udpPort, cmdUdpPort, debugPorts };
}

function updateStatusBar(udpPort: number, cmdUdpPort: number) {
  if (!statusBarIcon) return;
  statusBarIcon.text = `$(graph-line) LasecPlot`;
  statusBarIcon.tooltip = `UDP ${udpPort} • CMD ${cmdUdpPort}`;
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

        const srcList = rawHTML.match(/src="(.*?)"/g) ?? [];
        const hrefList = rawHTML.match(/href="(.*?)"/g) ?? [];
        for (const attr of [...srcList, ...hrefList]) {
          const url = attr.split('"')[1];
          const extensionURI = vscode.Uri.joinPath(context.extensionUri, "./media/" + url);
          const webURI = panel.webview.asWebviewUri(extensionURI);
          const toReplace = attr.replace(url, webURI.toString());
          rawHTML = rawHTML.replace(attr, toReplace);
        }

        const lasecplotStyle = rawHTML.match(/(.*)_lasecplot_default_color_style(.*)/g);
        if (lasecplotStyle != null) {
          rawHTML = rawHTML.replace(lasecplotStyle.toString(), 'var _lasecplot_default_color_style = "dark";');
        }

        panel.webview.html = rawHTML;

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
function normalizeWindowsPathForOpen(portPath: string): string {
  if (process.platform !== 'win32') return portPath;
  // COMx pode abrir direto; virtual (CNCA0 etc.) precisa \\.\NOME
  if (/^COM\d+$/i.test(portPath)) return portPath;
  // também útil para COM10+ (o serialport costuma lidar sozinho, mas não custa):
  if (!portPath.startsWith('\\\\.\\')) return `\\\\.\\${portPath}`;
  return portPath;
}

function runCmd(msg: any) {
  const id: string = ('id' in msg) ? msg.id : '';

  if (msg.cmd === 'listSerialPorts') {
    listSerialPortsRegistrySerialCommEnhanced().then((ports) => {
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: ports });
    }).catch(async (err) => {
      console.warn('[serial] registry SERIALCOMM failed, fallback:', err);
      const baseRaw = await SerialPort.list();
      const base = (baseRaw as any[]).map(normalizeSerialPortListItem);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: base });
    });
    return;
  }
  else if (msg.cmd === 'connectSerialPort') {
    if (serials[id]) {
      try { serials[id].close(); } catch { /* ignore */ }
      delete serials[id];
    }

    const rawPath: string = String(msg.port || '');
    const baud: number = Number(msg.baud) || 115200;
    if (!rawPath) {
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: rawPath, baud });
      return;
    }

    const portPath = normalizeWindowsPathForOpen(rawPath);

    const sp = new SerialPort({ path: portPath, baudRate: baud });
    serials[id] = sp;

    sp.on('open', () => {
      console.log('[serial] open', portPath);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortConnect', port: rawPath, baud });
    });
    sp.on('error', (err) => {
      console.log('[serial] error', err);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: rawPath, baud });
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
    serials[id]?.write(String(msg.text));
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

// ================== LISTA DE PORTAS (merge SerialPort + Registro) ==================
async function listSerialPortsRegistrySerialCommEnhanced(): Promise<LPort[]> {
  const { debugPorts } = getConfig();

  // SerialPort.list() -> normaliza para LPort
  const baseRaw = await SerialPort.list();
  const base: LPort[] = (baseRaw as any[]).map(normalizeSerialPortListItem);

  if (debugPorts) {
    console.log('[SERIALPORT.list] raw =>', baseRaw);
    console.log('[SERIALPORT.list] norm =>', base);
  }

  // Registro (SERIALCOMM)
  const reg: LPort[] = await listSerialPortsFromRegSerialComm();

  if (debugPorts) {
    console.log('[SERIALCOMM] merged entries =>', reg);
  }

  // Merge por COM (quando houver), senão por RAW:<devicePath|nome>
  const byKey = new Map<string, LPort>();

  // Primeiro o SerialPort.list (prioridade)
  for (const p of base) {
    const key = (p.path || '').toUpperCase();
    if (key) byKey.set(`COM:${key}`, { ...p });
  }

  // Depois o que veio do Registro
  for (const r of reg) {
    const hasCom = /^COM\d+$/i.test(r.path);
    const key = hasCom ? `COM:${r.path.toUpperCase()}` : `RAW:${(r.devicePath || r.path || '').toUpperCase()}`;
    const existing = byKey.get(key);
    const merged: LPort = { ...(existing || {}), ...r };

    // Heurística de virtual
    merged.isVirtual = inferVirtualFromStrings(
      merged.friendlyName, merged.pnpId, merged.devicePath, merged.manufacturer, merged.path
    );

    byKey.set(key, merged);
  }

  // Ordena: COMx por número, depois os RAW (sem COM)
  const comPorts: LPort[] = [];
  const rawOnly: LPort[] = [];

  for (const [k, v] of byKey) {
    if (k.startsWith('COM:')) comPorts.push(v);
    else rawOnly.push(v);
  }

  comPorts.sort((a, b) => {
    const na = parseInt((a.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    const nb = parseInt((b.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    return na - nb;
  });

  const out = [...comPorts, ...rawOnly];

  if (debugPorts) {
    console.log('[PORTS] final =>', out);
  }

  return out;
}

function normalizeSerialPortListItem(p: any): LPort {
  // SerialPort.list() muda de shape entre versões; mapeia para LPort
  const pathGuess = p.path || p.comName || p.port || '';
  return {
    path: pathGuess,
    friendlyName: p.friendlyName || p.friendly_name || pathGuess,
    manufacturer: p.manufacturer,
    serialNumber: p.serialNumber,
    vendorId: p.vendorId,
    productId: p.productId,
    locationId: p.locationId,
    pnpId: p.pnpId || p.pnp,
    devicePath: p.device || p.devicePath || p.path,
    source: 'serialport',
  };
}

async function listSerialPortsFromRegSerialComm(): Promise<LPort[]> {
  if (os.platform() !== 'win32') return [];

  const args = ['query', 'HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM'];
  const stdout = await execReg(args);

  const { debugPorts } = getConfig();
  if (debugPorts) {
    console.log('[SERIALCOMM] raw stdout ===\n' + stdout + '\n=== /SERIALCOMM');
  }

  const out: LPort[] = [];
  const lines = String(stdout || '').split(/\r?\n/);

  for (const line of lines) {
    // Formato: "<Nome>   REG_SZ   <Dados>"
    if (!/REG_SZ/i.test(line)) continue;

    const parts = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
    if (parts.length < 3) continue;

    const devicePath = parts[0];             // \Device\Serial0, \Device\com0com10, etc
    const dataColRaw = (parts[2] || '').trim(); // pode ser "COM3", "CNCA0", etc.
    const dataColUpper = dataColRaw.toUpperCase();

    // Mantemos tudo: se for COMx, ótimo (abrível). Se for CNCA0, listamos como “raw”
    const isCom = /^COM\d+$/i.test(dataColUpper);

    out.push({
      path: isCom ? dataColUpper : dataColRaw,   // COMx em maiúsculo; virtuais preservam casing
      devicePath,                                // 1ª coluna
      friendlyName: devicePath,
      source: 'SERIALCOMM',
      // isVirtual será inferido depois
    });
  }

  // de-dup por (path + devicePath)
  const uniq = new Map<string, LPort>();
  for (const p of out) {
    const key = `${(p.path || '').toUpperCase()}|${(p.devicePath || '').toUpperCase()}`;
    uniq.set(key, p);
  }
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
  const hints = ['com0com', 'virtual', 'null-modem', 'emulator', 'loopback', 'cnca', 'cncb'];
  return hints.some(h => hay.includes(h));
}