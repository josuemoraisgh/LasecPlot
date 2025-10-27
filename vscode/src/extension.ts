import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReadlineParser } from 'serialport';
const { SerialPort } = require('serialport');
const Readline = require('@serialport/parser-readline');
const udp = require('dgram');

type UdpSocket = import('dgram').Socket;

let serials: Record<string, any> = {};
let udpServer: UdpSocket | null = null;
let currentPanel: vscode.WebviewPanel | undefined;
let _disposables: vscode.Disposable[] = [];
let statusBarIcon: vscode.StatusBarItem;

// portas ativas (vindas das settings)
let udpPort = 47269;     // telemetria (default)
let cmdUdpPort = 47268;  // comandos (default)

function loadPortsFromSettings() {
  const cfg = vscode.workspace.getConfiguration('teleplot');
  udpPort = cfg.get<number>('udpPort', 47269);
  cmdUdpPort = cfg.get<number>('cmdUdpPort', 47268);
}

function stopUdpServer() {
  if (udpServer) {
    try { udpServer.close(); } catch {}
    udpServer = null;
  }
}

function startUdpServer() {
  stopUdpServer();

  const s: UdpSocket = udp.createSocket('udp4'); // cria o socket
  s.bind(udpPort);

  // Relay UDP packets para a webview
  s.on('message', (msg: any) => {
    if (currentPanel) {
      currentPanel.webview.postMessage({
        data: msg.toString(),
        fromSerial: false,
        timestamp: Date.now(),
      });
    }
  });

  udpServer = s; // só atribui no fim, evitando estado parcial
}

function startTeleplotServer() {
  loadPortsFromSettings();
  startUdpServer();
}

export function activate(context: vscode.ExtensionContext) {
  // Carrega portas uma vez no início
  loadPortsFromSettings();

  context.subscriptions.push(
    vscode.commands.registerCommand('teleplot.start', () => {
      startTeleplotServer();

      const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

      // Se já existe um painel, apenas revela.
      if (currentPanel) {
        currentPanel.reveal(column);
        return;
      }

      // Cria o painel novo.
      const panel = vscode.window.createWebviewPanel(
        'teleplot',
        'Teleplot',
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
        if (err) { console.error(err); return; }
        let rawHTML = data.toString();

        // Reescreve URLs para dentro da webview
        rawHTML = rawHTML.replace(/\b(src|href)=["']([^"']+)["']/g, (_m, attr, rel) => {
          // ignora URLs absolutas (http/https) e anchors
          if (/^(https?:)?\/\//i.test(rel) || rel.startsWith('#')) return _m;
          // normaliza contra a pasta media
          const extensionURI = vscode.Uri.joinPath(context.extensionUri, 'media', rel);
          const webURI = panel.webview.asWebviewUri(extensionURI);
          return `${attr}="${webURI.toString()}"`;
        });

        // Força tema padrão "dark" se houver marcador
        const teleplotStyle = rawHTML.match(/(.*)_teleplot_default_color_style(.*)/g);
        if (teleplotStyle != null) {
          rawHTML = rawHTML.replace(teleplotStyle.toString(), 'var _teleplot_default_color_style = "dark";');
        }

        panel.webview.html = rawHTML;
      });

      panel.onDidDispose(() => {
        stopUdpServer();
        while (_disposables.length) {
          const x = _disposables.pop();
          if (x) x.dispose();
        }
        _disposables.length = 0;
        for (const s in serials) {
          try { serials[s].close(); } catch {}
          serials[s] = null;
        }
        currentPanel = undefined;
      }, null, _disposables);

      panel.webview.onDidReceiveMessage(message => {
        if ('data' in message) {
          const udpClient = udp.createSocket('udp4');
          const buf = Buffer.isBuffer(message.data) ? message.data : Buffer.from(String(message.data));
          udpClient.send(buf, 0, buf.length, cmdUdpPort, () => {
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
  statusBarIcon.command = 'teleplot.start';
  statusBarIcon.text = '$(graph-line) Teleplot';
  context.subscriptions.push(statusBarIcon);
  statusBarIcon.show();

  // Reagir a mudanças nas configurações (reinicia server e passa a usar nova porta)
  const disp = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('teleplot.udpPort') || e.affectsConfiguration('teleplot.cmdUdpPort')) {
      console.log('[Teleplot] Config alterada — reiniciando sockets com novas portas.');
      startTeleplotServer();
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
      try { serials[id].close(); } catch {}
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
    try { serials[id]?.close(); } catch {}
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
    try { serials[s].close(); } catch {}
  }
  serials = {};
}
