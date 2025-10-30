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

// ================== TIPO LOCAL PARA PORTAS ==================
type LPort = {
  path: string;            // COMx
  friendlyName?: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  locationId?: string;
  pnpId?: string;
  devicePath?: string;     // \Device\Serial0 etc.
  isVirtual?: boolean;
  source?: string;         // 'serialport' | 'SERIALCOMM' | ...
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

    const portPath: string = msg.port;
    const baud: number = msg.baud;

    const sp = new SerialPort({ path: portPath, baudRate: baud });
    serials[id] = sp;

    sp.on('open', () => {
      console.log('[serial] open');
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortConnect', port: portPath, baud });
    });
    sp.on('error', (err) => {
      console.log('[serial] error', err);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: portPath, baud });
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
  // SerialPort.list() -> normaliza para LPort
  const baseRaw = await SerialPort.list();
  const base: LPort[] = (baseRaw as any[]).map(normalizeSerialPortListItem);

  // Registro (SERIALCOMM)
  const reg: LPort[] = await listSerialPortsFromRegSerialComm();

  // merge por COM
  const byCom = new Map<string, LPort>();
  for (const p of base) {
    if (p.path) byCom.set(p.path.toUpperCase(), { ...p });
  }

  for (const r of reg) {
    const key = r.path.toUpperCase();
    const existing = byCom.get(key);
    const merged: LPort = { ...(existing || {}), ...r };
    merged.isVirtual = inferVirtualFromStrings(
      merged.friendlyName, merged.pnpId, merged.devicePath, merged.manufacturer
    );
    byCom.set(key, merged);
  }

  const out = Array.from(byCom.values());
  out.sort((a, b) => {
    const na = parseInt((a.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    const nb = parseInt((b.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    return na - nb;
  });
  return out;
}

function normalizeSerialPortListItem(p: any): LPort {
  // SerialPort.list() muda de shape entre versões; mapeia para LPort
  return {
    path: p.path || p.comName || p.port || '',
    friendlyName: p.friendlyName || p.friendly_name || p.path || p.comName,
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

  const out: LPort[] = [];
  const lines = String(stdout || '').split(/\r?\n/);

  for (const line of lines) {
    // linhas do reg têm formato: "<Nome>   REG_SZ   <Dados>"
    if (!/REG_SZ/i.test(line)) continue;

    // split por múltiplos espaços ou tabs
    const parts = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
    // parts[0] = Nome (ex.: \Device\Serial0, \Device\com0com10, COM3)
    // parts[1] = "REG_SZ"
    // parts[2] = Dados (o que queremos) -> "COM1", "COM3", "CNCA0", etc.
    if (parts.length >= 3) {
      const devicePath = parts[0];
      const dataCol = (parts[2] || '').trim().toUpperCase(); // 3ª coluna

      // Só COMx é porta válida para abrir. (Valores tipo "CNCA0" são aliases do com0com.)
      if (/^COM\d+$/i.test(dataCol)) {
        out.push({
          path: dataCol,           // COMx (o que a extensão usa para abrir)
          devicePath,              // 1ª coluna, útil como "friendlyName" se quiser exibir
          friendlyName: devicePath,
          source: 'SERIALCOMM',
        });
      }
    }
  }

  // de-dup por COM
  const uniq = new Map<string, LPort>();
  for (const p of out) uniq.set(p.path.toUpperCase(), p);
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