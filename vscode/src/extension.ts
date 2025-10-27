import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReadlineParser } from 'serialport';
const { SerialPort } = require('serialport');
const Readline = require('@serialport/parser-readline');
const udp = require('dgram');

type UdpSocket = import('dgram').Socket;
// topo do arquivo
let lastUdpPeerIp = '127.0.0.1';

// ...
let serials: Record<string, any> = {};
let udpServer: UdpSocket | null = null;
let currentPanel: vscode.WebviewPanel | undefined;
let _disposables: vscode.Disposable[] = [];
let statusBarIcon: vscode.StatusBarItem;

// portas ativas (vindas das settings)
let udpPort = 47269;     // telemetria (default)
let cmdUdpPort = 47268;  // comandos (default)

function loadPortsFromSettings() {
  const cfg = vscode.workspace.getConfiguration('lasecplot');
  udpPort = cfg.get<number>('udpPort', 47269);
  cmdUdpPort = cfg.get<number>('cmdUdpPort', 47268);
}

function stopUdpServer() {
  if (udpServer) {
    try { udpServer.close(); } catch { }
    udpServer = null;
  }
}

function startUdpServer() {
  stopUdpServer();

  const s: UdpSocket = udp.createSocket('udp4');
  s.bind(udpPort);

  s.on('message', (msg: any, rinfo: { address: string; port: number }) => {
    // memorize o IP do último emissor
    lastUdpPeerIp = rinfo.address || '127.0.0.1';

    if (currentPanel) {
      currentPanel.webview.postMessage({
        data: msg.toString(),
        fromSerial: false,
        timestamp: Date.now(),
      });
    }
  });

  udpServer = s;
}


function startLasecPlotServer() {
  loadPortsFromSettings();
  startUdpServer();
  // Se já existe painel, informe as portas ativas ao front
  if (currentPanel) {
    currentPanel.webview.postMessage({ type: 'ports', udp: udpPort, cmd: cmdUdpPort });
  }
}

export function activate(context: vscode.ExtensionContext) {
  // Carrega portas uma vez no início
  loadPortsFromSettings();

  context.subscriptions.push(
    vscode.commands.registerCommand('lasecplot.start', () => {
      startLasecPlotServer();

      const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

      // Se já existe um painel, apenas revela e reenvia as portas.
      if (currentPanel) {
        currentPanel.reveal(column);
        currentPanel.webview.postMessage({ type: 'ports', udp: udpPort, cmd: cmdUdpPort });
        return;
      }

      // Cria o painel novo.
      const panel = vscode.window.createWebviewPanel(
        'lasecplot',
        'LasecPlot',
        column || vscode.ViewColumn.One,
        {
          enableScripts: true,
          localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))],
          retainContextWhenHidden: true,
          enableCommandUris: true,
        }
      );
      currentPanel = panel;

      fs.readFile(path.join(context.extensionPath, 'media', 'index.html'), (err, data) => {
        if (err) {
          console.error(err);
          return;
        }
        let rawHTML = data.toString();

        // Reescreve URLs para dentro da webview (src/href, aspas simples/duplas)
        rawHTML = rawHTML.replace(/\b(src|href)=["']([^"']+)["']/g, (_m, attr, rel) => {
          // ignora URLs absolutas (http/https) e anchors
          if (/^(https?:)?\/\//i.test(rel) || rel.startsWith('#')) return _m;
          // normaliza contra a pasta media
          const extensionURI = vscode.Uri.joinPath(context.extensionUri, 'media', rel);
          const webURI = panel.webview.asWebviewUri(extensionURI);
          return `${attr}="${webURI.toString()}"`;
        });

        // Força tema padrão "dark" se houver marcador
        const lasecplotStyle = rawHTML.match(/(.*)_lasecplot_default_color_style(.*)/g);
        if (lasecplotStyle != null) {
          rawHTML = rawHTML.replace(lasecplotStyle.toString(), 'var _lasecplot_default_color_style = "dark";');
        }

        panel.webview.html = rawHTML;

        // Após carregar o HTML, informe as portas ao front
        panel.webview.postMessage({
          kind: 'udp-ready',
          port: udpPort,
          cmdPort: cmdUdpPort
        });
      });

      panel.onDidDispose(() => {
        stopUdpServer();
        while (_disposables.length) {
          const x = _disposables.pop();
          if (x) x.dispose();
        }
        _disposables.length = 0;
        for (const s in serials) {
          try { serials[s].close(); } catch { }
          serials[s] = null;
        }
        currentPanel = undefined;
      }, null, _disposables);

      panel.webview.onDidReceiveMessage(message => {
        if ('data' in message) {
          const udpClient = udp.createSocket('udp4');
          const buf = Buffer.isBuffer(message.data) ? message.data : Buffer.from(String(message.data));

          // Envia para o mesmo IP do último pacote recebido, na porta CMD
          const host = lastUdpPeerIp || '127.0.0.1';
          udpClient.send(buf, 0, buf.length, cmdUdpPort, host, () => {
            udpClient.close();
          });
        } else if ('cmd' in message) {
          runCmd(message);
        }
      }, null, _disposables);
    })
  );

  // Status bar
  statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarIcon.command = 'lasecplot.start';
  statusBarIcon.text = '$(graph-line) LasecPlot';
  context.subscriptions.push(statusBarIcon);
  statusBarIcon.show();

  // Reagir a mudanças nas configurações (reinicia server e passa a usar nova porta)
  const disp = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('lasecplot.udpPort') || e.affectsConfiguration('lasecplot.cmdUdpPort')) {
      console.log('[LasecPlot] Config alterada — reiniciando sockets com novas portas.');
      startLasecPlotServer();
      currentPanel?.webview.postMessage({ type: 'ports', udp: udpPort, cmd: cmdUdpPort });
    }
  });
  context.subscriptions.push(disp);
}

var dataBuffer = '';
function runCmd(msg: any) {
  const id = ('id' in msg) ? msg.id : '';
  if (msg.cmd === 'listSerialPorts') {
    SerialPort.list().then((ports: any) => {
      if (currentPanel) {
        currentPanel.webview.postMessage({ id, cmd: 'serialPortList', list: ports });
      }
    });
  }
  else if (msg.cmd === 'connectSerialPort') {
    if (serials[id]) { // já existe
      try { serials[id].close(); } catch { }
      delete serials[id];
    }
    serials[id] = new SerialPort({ baudRate: msg.baud, path: msg.port }, (err: any) => {
      if (err) {
        console.log('serial error:', err);
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: msg.port, baud: msg.baud });
      } else {
        console.log('serial open');
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortConnect', port: msg.port, baud: msg.baud });
      }
    });

    const parser = serials[id].pipe(new ReadlineParser({ delimiter: '\n' }));
    parser.on('data', (data: any) => {
      currentPanel?.webview.postMessage({ id, data: String(data), fromSerial: true, timestamp: new Date().getTime() });
    });
    serials[id].on('close', (_err: any) => {
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortDisconnect' });
    });
  }
  else if (msg.cmd === 'sendToSerial') {
    serials[id]?.write(msg.text);
  }
  else if (msg.cmd === 'disconnectSerialPort') {
    try { serials[id]?.close(); } catch { }
    delete serials[id];
  }
  else if (msg.cmd === 'saveFile') {
    try {
      exportDataWithConfirmation(path.join(msg.file.name), { JSON: ['json'] }, msg.file.content);
    } catch (error) {
      void vscode.window.showErrorMessage("Couldn't write file: " + error);
    }
  }
}

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

export function deactivate() {
  stopUdpServer();
  for (const s in serials) {
    try { serials[s].close(); } catch { }
  }
  serials = {};
}
