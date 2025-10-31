// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { spawn, execFile } from 'child_process';
import * as dgram from 'dgram';

/**
 * LasecPlot – implementação sem "serialport" do Node.
 * Usa o helper em Go p/ listar/abrir portas e faz fallback no Registro (Windows).
 */

const CONFIG_NS = 'lasecplot';
const CFG_UDP_ADDRESS = 'udpAddress';
const CFG_UDP_PORT = 'udpPort';
const CFG_CMD_UDP_PORT = 'cmdUdpPort';

// ---------- Estado ----------
let statusBarIcon: vscode.StatusBarItem;
let currentPanel: vscode.WebviewPanel | null = null;
let udpServer: dgram.Socket | null = null;
const _disposables: vscode.Disposable[] = [];

type SerialSession = {
  proc: import('child_process').ChildProcessWithoutNullStreams;
  port: string;
  baud: number;
};
const sessions: Record<string, SerialSession> = {};

// ---------- Config / Statusbar / UDP ----------
function getConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const udpAddress = cfg.get<string>(CFG_UDP_ADDRESS, '127.0.0.1');
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

function bindUdpServer(udpPort: number) {
  if (udpServer) {
    try { udpServer.close(); } catch {}
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
}

// ---------- Helper (caminhos) ----------
function platformFolder(): string {
  const p = process.platform;
  const arch = process.arch;
  if (p === 'win32') return arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  if (p === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
}
function helperExecutableName(): string {
  return process.platform === 'win32' ? 'lasecplot-helper.exe' : 'lasecplot-helper';
}
function resolveHelperPath(ctx: vscode.ExtensionContext): string {
  // 1) VSIX instalado
  const binInExt = path.join(ctx.extensionPath, 'bin', platformFolder(), helperExecutableName());
  if (fs.existsSync(binInExt)) return binInExt;

  // 2) Dev/F5: <workspace>/vscode/bin/...
  const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (ws) {
    const devBin = path.join(ws, 'vscode', 'bin', platformFolder(), helperExecutableName());
    if (fs.existsSync(devBin)) return devBin;
  }

  // 3) PATH
  return helperExecutableName();
}

// ---------- Listagem de portas ----------
type PortInfoLite = {
  path: string;            // "COM3" | "/dev/ttyUSB0"
  friendlyName?: string;
  manufacturer?: string;
  isVirtual?: boolean;
  devicePath?: string;
  _source?: string;
};

function execReg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err);
      resolve(String(stdout || ''));
    });
  });
}

async function listFromWindowsRegistry(): Promise<PortInfoLite[]> {
  if (os.platform() !== 'win32') return [];
  const out: PortInfoLite[] = [];
  try {
    const stdout = await execReg(['query','HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM']);
    const lines = stdout.split(/\r?\n/);
    for (const line of lines) {
      if (!/REG_SZ/i.test(line)) continue;
      const parts = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
      if (parts.length >= 3) {
        const devicePath = parts[0];
        const dataCol = (parts[2] || '').trim().toUpperCase();
        if (/^COM\d+$/i.test(dataCol)) {
          out.push({
            path: dataCol,
            devicePath,
            friendlyName: devicePath,
            _source: 'SERIALCOMM'
          });
        }
      }
    }
  } catch (e) {
    console.warn('[serial] registry read failed:', e);
  }
  const uniq = new Map<string, PortInfoLite>();
  for (const p of out) uniq.set(p.path.toUpperCase(), p);
  return Array.from(uniq.values());
}

async function listViaHelper(ctx: vscode.ExtensionContext): Promise<PortInfoLite[]> {
  const helper = resolveHelperPath(ctx);
  return new Promise<PortInfoLite[]>((resolve, reject) => {
    const p = spawn(helper, ['list'], { stdio: ['ignore','pipe','pipe'] });
    let buf = '', err = '';
    p.stdout.on('data', d => buf += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err || `helper exited ${code}`));
      try { resolve(JSON.parse(buf)); }
      catch (e) { reject(new Error('invalid JSON from helper: ' + e)); }
    });
  });
}

async function listSerialPorts(ctx: vscode.ExtensionContext): Promise<PortInfoLite[]> {
  try {
    const via = await listViaHelper(ctx);
    via.sort((a,b) => {
      const na = parseInt((a.path||'').replace(/[^0-9]/g,'')) || 0;
      const nb = parseInt((b.path||'').replace(/[^0-9]/g,'')) || 0;
      if (na && nb) return na - nb;
      return (a.path||'').localeCompare((b.path||''));
    });
    return via;
  } catch (e) {
    console.warn('[serial] list via helper failed:', e);
  }
  const reg = await listFromWindowsRegistry();
  reg.sort((a,b) => {
    const na = parseInt((a.path||'').replace(/[^0-9]/g,'')) || 0;
    const nb = parseInt((b.path||'').replace(/[^0-9]/g,'')) || 0;
    if (na && nb) return na - nb;
    return (a.path||'').localeCompare((b.path||''));
  });
  return reg;
}

// ---------- Serial via helper ----------
function openSerial(ctx: vscode.ExtensionContext, id: string, port: string, baud: number) {
  closeSerial(id);
  const helper = resolveHelperPath(ctx);
  const child = spawn(helper, ['open','--port', port, '--baud', String(baud), '--read'],
    { stdio: ['pipe','pipe','pipe'] });

  child.stdout.on('data', (d) => {
    currentPanel?.webview.postMessage({
      id,
      data: d.toString(),
      fromSerial: true,
      timestamp: Date.now()
    });
  });
  child.stderr.on('data', (d) => console.warn('[serial] stderr:', d.toString()));
  child.on('close', () => {
    delete sessions[id];
    currentPanel?.webview.postMessage({ id, cmd: 'serialPortDisconnect' });
  });

  sessions[id] = { proc: child, port, baud };
  currentPanel?.webview.postMessage({ id, cmd: 'serialPortConnect', port, baud });
}

function sendToSerial(id: string, text: string) {
  const s = sessions[id];
  if (!s) return;
  try { s.proc.stdin.write(text); }
  catch (e) { console.warn('[serial] write failed:', e); }
}
function closeSerial(id: string) {
  const s = sessions[id];
  if (!s) return;
  try { s.proc.kill(); } catch {}
  delete sessions[id];
}

// ---------- Activate / Webview ----------
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('lasecplot.start', () => openPanel(context))
  );

  statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarIcon.command = 'lasecplot.start';
  statusBarIcon.text = '$(graph-line) LasecPlot';
  context.subscriptions.push(statusBarIcon);
  statusBarIcon.show();

  const { udpPort, cmdUdpPort } = getConfig();
  updateStatusBar(udpPort, cmdUdpPort);
}

function openPanel(context: vscode.ExtensionContext) {
  const { udpAddress, udpPort, cmdUdpPort } = getConfig();
  bindUdpServer(udpPort);

  const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
  if (currentPanel) { currentPanel.reveal(column, false); return; }

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

    const themeVar = rawHTML.match(/(.*)_lasecplot_default_color_style(.*)/g);
    if (themeVar) {
      rawHTML = rawHTML.replace(themeVar.toString(), 'var _lasecplot_default_color_style = "dark";');
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
    if (udpServer) { try { udpServer.close(); } catch {} udpServer = null; }
    Object.keys(sessions).forEach(closeSerial);
    while (_disposables.length) { const x = _disposables.pop(); if (x) x.dispose(); }
    currentPanel = null;
  }, null, _disposables);

  panel.webview.onDidReceiveMessage(async (message) => {
    if (message?.type === 'saveAddressPort') {
      const { cfg, udpPort: currUDP, cmdUdpPort: currCmd } = getConfig();
      const host = String(message.host || '').trim();
      const portNum = Number(message.port);
      if (host) await cfg.update(CFG_UDP_ADDRESS, host, vscode.ConfigurationTarget.Global);
      if (Number.isFinite(portNum) && portNum !== currUDP) {
        await cfg.update(CFG_UDP_PORT, portNum, vscode.ConfigurationTarget.Global);
        bindUdpServer(portNum);
        updateStatusBar(portNum, currCmd);
      } else {
        updateStatusBar(currUDP, currCmd);
      }
      return;
    }

    if (message?.type === 'saveCmdPort') {
      const { cfg, udpPort: currUDP } = getConfig();
      const portNum = Number(message.port);
      if (Number.isFinite(portNum)) {
        await cfg.update(CFG_CMD_UDP_PORT, portNum, vscode.ConfigurationTarget.Global);
        const { cmdUdpPort } = getConfig();
        updateStatusBar(currUDP, cmdUdpPort);
      }
      return;
    }

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

    if ('cmd' in message) {
      runCmdFromWebview(context, message);
      return;
    }
  }, null, _disposables);
}

function runCmdFromWebview(ctx: vscode.ExtensionContext, msg: any) {
  const id: string = ('id' in msg) ? String(msg.id) : '';

  if (msg.cmd === 'listSerialPorts') {
    listSerialPorts(ctx).then((ports) => {
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: ports });
    }).catch((err) => {
      console.warn('[serial] list failed altogether:', err);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: [] });
    });
    return;
  }

  if (msg.cmd === 'connectSerialPort') {
    const portPath: string = msg.port;
    const baud: number = Number(msg.baud) || 115200;
    openSerial(ctx, id, portPath, baud);
    return;
  }

  if (msg.cmd === 'sendToSerial') {
    sendToSerial(id, String(msg.text || ''));
    return;
  }

  if (msg.cmd === 'disconnectSerialPort') {
    closeSerial(id);
    return;
  }

  if (msg.cmd === 'saveFile') {
    try {
      exportDataWithConfirmation(path.join(msg.file.name), { JSON: ['json'] }, msg.file.content);
    } catch (error: any) {
      void vscode.window.showErrorMessage("Couldn't write file: " + error);
    }
    return;
  }
}

// ---------- Save helper ----------
function exportDataWithConfirmation(fileName: string, filters: { [name: string]: string[] }, data: string): void {
  void vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(fileName),
    filters,
  }).then((uri: vscode.Uri | undefined) => {
    if (uri) {
      const value = uri.fsPath;
      fs.writeFile(value, data, (error:any) => {
        if (error) {
          void vscode.window.showErrorMessage('Could not write to file: ' + value + ': ' + error.message);
        } else {
          void vscode.window.showInformationMessage('Saved ' + value );
        }
      });
    }
  });
}

export function deactivate() {
  if (udpServer) { try { udpServer.close(); } catch {} udpServer = null; }
  Object.keys(sessions).forEach(closeSerial);
}