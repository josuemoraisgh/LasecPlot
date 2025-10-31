// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import * as dgram from 'dgram';

// ================== CONFIG ==================
const CONFIG_NS = 'lasecplot';
const CFG_UDP_ADDRESS   = 'udpAddress';     // endereço local para receber dados UDP (viewer)
const CFG_UDP_PORT      = 'udpPort';        // porta de dados UDP (viewer)
const CFG_CMD_UDP_PORT  = 'cmdUdpPort';     // porta de comando UDP (lado remoto)
const CFG_REMOTE_ADDR   = 'remoteAddress';  // (se você usa no webview) endereço remoto para CONNECT
const CFG_GO_HELPER     = 'goHelperPath';   // caminho do binário helper em Go (opcional)

// ================== ESTADO GLOBAL ==================
let udpServer: dgram.Socket | null = null;
let currentPanel: vscode.WebviewPanel | null = null;
const _disposables: vscode.Disposable[] = [];
let statusBarIcon: vscode.StatusBarItem;

// ================== TIPOS AUXILIARES ==================
type PortInfoLite = {
  path: string;                // "COM3", "/dev/ttyUSB0", etc
  friendlyName?: string;       // texto bonito
  isVirtual?: boolean;         // heurística do helper
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
  deviceLocation?: string;
  pnpId?: string;
  _source?: string;            // para debug: "go-helper", etc
};

// ================== CONFIG HELPERS ==================
function getConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const udpAddress  = cfg.get<string>(CFG_UDP_ADDRESS, '127.0.0.1');
  const udpPort     = cfg.get<number>(CFG_UDP_PORT, 47269);
  const cmdUdpPort  = cfg.get<number>(CFG_CMD_UDP_PORT, 47268);
  const remoteAddr  = cfg.get<string>(CFG_REMOTE_ADDR, '127.0.0.1');
  const goHelper    = cfg.get<string>(CFG_GO_HELPER, '');
  return { cfg, udpAddress, udpPort, cmdUdpPort, remoteAddr, goHelper };
}

function updateStatusBar(udpPort: number, cmdUdpPort: number) {
  if (!statusBarIcon) return;
  statusBarIcon.text = `$(graph-line) LasecPlot`;
  statusBarIcon.tooltip = `UDP ${udpPort} • CMD ${cmdUdpPort}`;
  statusBarIcon.command = 'lasecplot.start';
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
      const { udpAddress, udpPort, cmdUdpPort, remoteAddr } = getConfig();
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

      // carrega index.html e reescreve src/href
      fs.readFile(path.join(context.extensionPath, 'media', 'index.html'), (err, data) => {
        if (err) { console.error(err); return; }
        let rawHTML = data.toString();

        const srcList  = rawHTML.match(/src="(.*?)"/g)  ?? [];
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

        // entrega config inicial ao webview
        panel.webview.postMessage({
          type: 'initConfig',
          udpAddress,
          udpPort,
          cmdUdpPort,
          remoteAddr
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

        // payload para porta de comando (envia do host -> remoto)
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

        // comandos gerais (serial agora via helper em Go)
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

// ================== COMANDOS / SHIMS PARA SERIAL (via Go helper) ==================
function runCmd(msg: any) {
  const id: string = ('id' in msg) ? msg.id : '';

  switch (msg.cmd) {
    case 'listSerialPorts':
      listSerialViaGoHelper().then((ports) => {
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: ports });
      }).catch((err) => {
        console.warn('[serial] list via Go helper failed:', err);
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: [] as PortInfoLite[] });
      });
      break;

    case 'connectSerialPort':
      openSerialViaGoHelper(id, msg.port, msg.baud).then((ok) => {
        if (ok) {
          currentPanel?.webview.postMessage({ id, cmd: 'serialPortConnect', port: msg.port, baud: msg.baud });
          // Nota: o streaming de dados serial -> webview também deve vir do helper (ex.: via UDP/IPC)
          // Aqui, sem helper ativo, não há push de dados.
        } else {
          currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: msg.port, baud: msg.baud });
        }
      }).catch((_e) => {
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: msg.port, baud: msg.baud });
      });
      break;

    case 'sendToSerial':
      writeSerialViaGoHelper(id, msg.text).then(() => {
        // ok
      }).catch((_e) => {
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortError' });
      });
      break;

    case 'disconnectSerialPort':
      closeSerialViaGoHelper(id).then(() => {
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortDisconnect' });
      }).catch((_e) => {
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortDisconnect' });
      });
      break;

    case 'saveFile':
      try {
        exportDataWithConfirmation(path.join(msg.file.name), { JSON: ['json'] }, msg.file.content);
      } catch (error: any) {
        void vscode.window.showErrorMessage("Couldn't write file: " + error);
      }
      break;

    default:
      console.warn('[cmd] desconhecido:', msg.cmd);
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

// ================== INTEGRAÇÃO COM HELPER EM GO ==================
// Convenção proposta (ajuste no seu binário Go quando pronto):
//   lasecplot-helper list-serial --json
//   lasecplot-helper open-serial   --id <id> --port <COM3> --baud <115200>
//   lasecplot-helper write-serial  --id <id> --text "<payload>"
//   lasecplot-helper close-serial  --id <id>
//
// Observação: o "stream" de leitura serial -> UI você pode fazer o helper enviar
// por UDP para (udpAddress:udpPort) com o mesmo formato que você já usa.

function resolveGoHelperPath(): string | null {
  const { goHelper } = getConfig();
  if (goHelper && fs.existsSync(goHelper)) return goHelper;

  // tenta nomes padrão no PATH
  const candidates = os.platform() === 'win32'
    ? ['lasecplot-helper.exe', 'lasecplot-go-helper.exe']
    : ['lasecplot-helper', 'lasecplot-go-helper'];

  for (const name of candidates) {
    // confia no PATH (execFile resolve)
    return name;
  }
  return null;
}

function execHelper(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const helper = resolveGoHelperPath();
    if (!helper) return reject(new Error('Go helper path not configured'));
    execFile(helper, args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err);
      resolve(String(stdout || ''));
    });
  });
}

async function listSerialViaGoHelper(): Promise<PortInfoLite[]> {
  // Se não houver helper, retorna lista vazia
  const helper = resolveGoHelperPath();
  if (!helper) return [];

  const args = ['list-serial', '--json'];
  const out = await execHelper(args);
  try {
    const arr = JSON.parse(out);
    if (Array.isArray(arr)) {
      return arr.map((p: any) => ({
        path: String(p.path || ''),
        friendlyName: p.friendlyName ? String(p.friendlyName) : undefined,
        isVirtual: !!p.isVirtual,
        manufacturer: p.manufacturer ? String(p.manufacturer) : undefined,
        productId: p.productId ? String(p.productId) : undefined,
        vendorId: p.vendorId ? String(p.vendorId) : undefined,
        deviceLocation: p.deviceLocation ? String(p.deviceLocation) : undefined,
        pnpId: p.pnpId ? String(p.pnpId) : undefined,
        _source: 'go-helper'
      } as PortInfoLite)).filter(p => p.path);
    }
    return [];
  } catch {
    return [];
  }
}

async function openSerialViaGoHelper(id: string, port: string, baud: number): Promise<boolean> {
  const helper = resolveGoHelperPath();
  if (!helper) return false;
  const args = ['open-serial', '--id', id, '--port', port, '--baud', String(baud)];
  await execHelper(args);
  return true;
}

async function writeSerialViaGoHelper(id: string, text: string): Promise<void> {
  const helper = resolveGoHelperPath();
  if (!helper) throw new Error('helper missing');
  const args = ['write-serial', '--id', id, '--text', String(text ?? '')];
  await execHelper(args);
}

async function closeSerialViaGoHelper(id: string): Promise<void> {
  const helper = resolveGoHelperPath();
  if (!helper) return;
  const args = ['close-serial', '--id', id];
  await execHelper(args);
}