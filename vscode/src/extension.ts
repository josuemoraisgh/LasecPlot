// extension.ts — LasecPlot
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReadlineParser } from 'serialport';
const { SerialPort } = require('serialport');
const udp = require('dgram');

let statusBarIcon: vscode.StatusBarItem | undefined;
let currentPanel: vscode.WebviewPanel | undefined;
let _disposables: vscode.Disposable[] = [];
let udpServer: any = null; // data UDP server (listens on udpPort)
let serials: Record<string, any> = {}; // id -> SerialPort

// ---------------- Status Bar ----------------
function ensureStatusBar(context: vscode.ExtensionContext) {
  if (!statusBarIcon) {
    statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarIcon.command = 'lasecplot.start';
    context.subscriptions.push(statusBarIcon);
  }
}

function updateStatusBar(udpPort: number, cmdUdpPort: number, remoteAddress: string) {
  if (!statusBarIcon) return;
  statusBarIcon.text = `$(graph-line) LasecPlot`;
  statusBarIcon.tooltip = `UDP ${udpPort} • CMD ${cmdUdpPort}` + (remoteAddress ? ` • ${remoteAddress}` : '');
  statusBarIcon.show();
}

// --------------- Helpers de Config ---------------
function getConfig() {
  const cfg = vscode.workspace.getConfiguration('lasecplot');
  const udpPort = cfg.get<number>('udpPort', 47269);
  const cmdUdpPort = cfg.get<number>('cmdUdpPort', 47268);
  const remoteAddress = cfg.get<string>('remoteAddress', '127.0.0.1') || '127.0.0.1';
  return { udpPort, cmdUdpPort, remoteAddress };
}

// --------------- Webview HTML loader ---------------
function loadWebviewHtml(context: vscode.ExtensionContext, panel: vscode.WebviewPanel) {
  const p = path.join(context.extensionPath, 'media', 'index.html');
  const raw = fs.readFileSync(p, 'utf8');
  let html = raw;

  // Reescreve src/href para as URIs do webview
  const srcList = html.match(/src\=\"(.*?)\"/g) || [];
  const hrefList = html.match(/href\=\"(.*?)\"/g) || [];
  for (const attr of [...srcList, ...hrefList]) {
    const url = attr.split('"')[1];
    const extensionURI = vscode.Uri.joinPath(context.extensionUri, './media/' + url);
    const webURI = panel.webview.asWebviewUri(extensionURI);
    html = html.replace(attr, attr.replace(url, webURI.toString()));
  }

  // Define tema padrão escuro, se variável existir
  const m = html.match(/(.*)_lasecplot_default_color_style(.*)/g);
  if (m) {
    html = html.replace(m.toString(), 'var _lasecplot_default_color_style = "dark";');
  }

  return html;
}

// --------------- UDP Data Server ---------------
function startLasecPlotServer(udpPort: number) {
  stopLasecPlotServer();
  udpServer = udp.createSocket('udp4');
  udpServer.bind(udpPort);

  udpServer.on('message', function (msg: any, info: any) {
    // Encaminha para o webview como mensagem de DEVICE via UDP
    if (currentPanel) {
      currentPanel.webview.postMessage({
        data: msg.toString(),
        fromUDP: true,
        timestamp: Date.now()
      });
    }
  });

  udpServer.on('error', (err: any) => {
    console.error('[UDP] server error:', err);
  });
}

function stopLasecPlotServer() {
  if (udpServer) {
    try { udpServer.close(); } catch {}
    udpServer = null;
  }
}

// --------------- Envio de comando UDP ---------------
function sendUdpCommand(remoteAddress: string, cmdUdpPort: number, payload: Buffer | string) {
  const client = udp.createSocket('udp4');
  const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  client.send(buf, 0, buf.length, cmdUdpPort, remoteAddress, () => {
    client.close();
  });
}

// --------------- Serial Helpers ---------------
function postToWebview(obj: any) {
  if (currentPanel) currentPanel.webview.postMessage(obj);
}

function handleSerialList(id: string) {
  SerialPort.list().then((ports: any) => {
    postToWebview({ id, cmd: 'serialPortList', list: ports });
  });
}

function handleSerialConnect(msg: any) {
  const id = msg.id;
  const port = msg.port;
  const baud = msg.baud;

  if (serials[id]) {
    try { serials[id].close(); } catch {}
    delete serials[id];
  }

  serials[id] = new SerialPort({ baudRate: baud, path: port }, (err: any) => {
    if (err) {
      console.log('[serial] open error:', err);
      postToWebview({ id, cmd: 'serialPortError', port, baud });
    } else {
      console.log('[serial] open ok');
      postToWebview({ id, cmd: 'serialPortConnect', port, baud });
    }
  });

  const parser = serials[id].pipe(new ReadlineParser({ delimiter: '\n' }));
  parser.on('data', (data: any) => {
    postToWebview({ id, data: data.toString(), fromSerial: true, timestamp: Date.now() });
  });
  serials[id].on('close', (err: any) => {
    postToWebview({ id, cmd: 'serialPortDisconnect' });
  });
}

function handleSerialSend(msg: any) {
  const id = msg.id;
  if (!serials[id]) return;
  serials[id].write(msg.text);
}

function handleSerialDisconnect(msg: any) {
  const id = msg.id;
  if (!serials[id]) return;
  try { serials[id].close(); } catch {}
  delete serials[id];
}

// --------------- Export de arquivo ---------------
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

// --------------- Comando principal ---------------
export function activate(context: vscode.ExtensionContext) {
  console.log('[LasecPlot] activate');
  ensureStatusBar(context);

  // registra comando start
  const startCmd = vscode.commands.registerCommand('lasecplot.start', () => {
    const { udpPort, cmdUdpPort, remoteAddress } = getConfig();
    // inicia UDP data server
    startLasecPlotServer(udpPort);

    // cria/abre webview
    const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : vscode.ViewColumn.One;
    if (currentPanel) {
      currentPanel.reveal(column);
    } else {
      const panel = vscode.window.createWebviewPanel(
        'lasecplot',
        'LasecPlot',
        column,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
          retainContextWhenHidden: true,
          enableCommandUris: true
        }
      );
      currentPanel = panel;
      panel.webview.html = loadWebviewHtml(context, panel);

      // dispose
      panel.onDidDispose(() => {
        stopLasecPlotServer();
        while (_disposables.length) {
          const x = _disposables.pop();
          if (x) x.dispose();
        }
        for (const k of Object.keys(serials)) {
          try { serials[k].close(); } catch {}
          delete serials[k];
        }
        currentPanel = undefined;
      }, null, _disposables);

      // mensagens do webview
      panel.webview.onDidReceiveMessage(message => {
        // 1) Dados de variáveis (texto) — enviar para CMD_UDP_PORT no remoteAddress
        if ('data' in message) {
          const buf: Buffer = Buffer.isBuffer(message.data)
            ? message.data
            : Buffer.from(String(message.data));
          sendUdpCommand(remoteAddress, cmdUdpPort, buf);
          return;
        }
        // 2) Comandos de controle (serial, salvar, etc.)
        if ('cmd' in message) {
          const msg = message;
          const id = msg.id ?? '';
          switch (msg.cmd) {
            case 'listSerialPorts':
              handleSerialList(id);
              break;
            case 'connectSerialPort':
              handleSerialConnect(msg);
              break;
            case 'sendToSerial':
              handleSerialSend(msg);
              break;
            case 'disconnectSerialPort':
              handleSerialDisconnect(msg);
              break;
            case 'saveFile':
              try {
                exportDataWithConfirmation(path.join(msg.file.name), { JSON: ['json'] }, msg.file.content);
              } catch (error: any) {
                void vscode.window.showErrorMessage("Couldn't write file: " + error?.message ?? String(error));
              }
              break;
            default:
              console.warn('[webview] comando desconhecido:', msg.cmd);
          }
        }
      }, null, _disposables);
    }

    // atualiza status bar com as configs atuais
    updateStatusBar(udpPort, cmdUdpPort, remoteAddress);
  });
  context.subscriptions.push(startCmd);

  // mostra status bar já no startup com as configs atuais
  {
    const { udpPort, cmdUdpPort, remoteAddress } = getConfig();
    updateStatusBar(udpPort, cmdUdpPort, remoteAddress);
  }

  // reflete mudanças de configuração em tempo real
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('lasecplot')) {
        const { udpPort, cmdUdpPort, remoteAddress } = getConfig();
        // reinicia servidor de dados se a porta mudou
        if (udpServer) {
          stopLasecPlotServer();
          startLasecPlotServer(udpPort);
        }
        updateStatusBar(udpPort, cmdUdpPort, remoteAddress);
      }
    })
  );
}

export function deactivate() {
  stopLasecPlotServer();
  if (statusBarIcon) statusBarIcon.hide();
  for (const k of Object.keys(serials)) {
    try { serials[k].close(); } catch {}
    delete serials[k];
  }
}