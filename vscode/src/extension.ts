import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReadlineParser } from 'serialport';
const { SerialPort } = require('serialport');
const Readline = require('@serialport/parser-readline');
const udp = require('dgram');

const CONFIG_NS = 'lasecplot';
const CFG_UDP_ADDRESS = 'udpAddress';
const CFG_UDP_PORT = 'udpPort';
const CFG_CMD_UDP_PORT = 'cmdUdpPort';
const CFG_REMOTE_ADDRESS = 'remoteAddress';

let serials: Record<string, any> = {};
let udpServer: any = null;
let currentPanel: vscode.WebviewPanel | null = null;
let _disposables: vscode.Disposable[] = [];
let statusBarIcon: vscode.StatusBarItem;

function getConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const udpAddress = cfg.get<string>(CFG_UDP_ADDRESS, '');
  const udpPort = cfg.get<number>(CFG_UDP_PORT, 47269);
  const cmdUdpPort = cfg.get<number>(CFG_CMD_UDP_PORT, 47268);
  const remoteAddress = cfg.get<string>(CFG_REMOTE_ADDRESS, '127.0.0.1');
  return { cfg, udpAddress, udpPort, cmdUdpPort, remoteAddress };
}

function updateStatusBar(udpPort: number, cmdUdpPort: number, remoteAddress: string) {
  if (!statusBarIcon) return;
  statusBarIcon.text = `$(graph-line) LasecPlot  udp:${udpPort}  cmd:${cmdUdpPort}@${remoteAddress}`;
  statusBarIcon.show();
}

function bindUdpServer(udpPort: number, cmdUdpPort: number, remoteAddress: string) {
  if (udpServer) {
    try { udpServer.close(); } catch { }
    udpServer = null;
  }
  udpServer = udp.createSocket('udp4');
  udpServer.bind(udpPort);
  udpServer.on('message', function (msg: any, _info: any) {
    if (currentPanel) {
      currentPanel.webview.postMessage({ data: msg.toString(), fromUDP: true, timestamp: Date.now() });
    }
  });
  updateStatusBar(udpPort, cmdUdpPort, remoteAddress);
}

async function saveAddressPort(address: string, port: number) {
  const { cfg, udpPort, cmdUdpPort, remoteAddress } = getConfig();
  await cfg.update(CFG_UDP_ADDRESS, address, vscode.ConfigurationTarget.Global);
  if (udpPort !== port) {
    await cfg.update(CFG_UDP_PORT, port, vscode.ConfigurationTarget.Global);
    bindUdpServer(port, cmdUdpPort, remoteAddress);
  } else {
    updateStatusBar(udpPort, cmdUdpPort, remoteAddress);
  }
}

async function saveCmdPort(port: number) {
  const { cfg, udpPort, cmdUdpPort, remoteAddress } = getConfig();
  if (cmdUdpPort !== port) {
    await cfg.update(CFG_CMD_UDP_PORT, port, vscode.ConfigurationTarget.Global);
    updateStatusBar(udpPort, port, remoteAddress);
  }
}

async function saveRemoteAddress(address: string) {
  const { cfg, udpPort, cmdUdpPort } = getConfig();
  await cfg.update(CFG_REMOTE_ADDRESS, address, vscode.ConfigurationTarget.Global);
  const { remoteAddress } = getConfig();
  updateStatusBar(udpPort, cmdUdpPort, remoteAddress);
}

export function activate(context: vscode.ExtensionContext) {
  statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarIcon.command = 'lasecplot.start';
  context.subscriptions.push(statusBarIcon);

  context.subscriptions.push(
    vscode.commands.registerCommand('lasecplot.start', () => {
      const { udpAddress, udpPort, cmdUdpPort, remoteAddress } = getConfig();

      bindUdpServer(udpPort, cmdUdpPort, remoteAddress);

      const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

      if (currentPanel) {
        currentPanel.reveal(column);
        return;
      }

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
        if (err) { console.error(err); return; }
        let rawHTML = data.toString();

        const srcList = rawHTML.match(/src\="(.*?)"/g) || [];
        const hrefList = rawHTML.match(/href\="(.*?)"/g) || [];

        for (let attr of [...srcList, ...hrefList]) {
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
          remoteAddress,
        });
      });

      panel.onDidDispose(() => {
        if (udpServer) { try { udpServer.close(); } catch { } }
        udpServer = null;
        while (_disposables.length) {
          const x = _disposables.pop();
          if (x) x.dispose();
        }
        _disposables.length = 0;
        for (let s in serials) {
          try { serials[s].close(); } catch { }
          serials[s] = null;
        }
        currentPanel = null;
      }, null, _disposables);

      panel.webview.onDidReceiveMessage(async (message) => {
        if (message && message.type === 'saveAddressPort') {
          const host = String(message.host || '').trim();
          const portNum = Number(message.port);
          if (host && Number.isFinite(portNum)) {
            await saveAddressPort(host, portNum);
          }
          return;
        }
        if (message && message.type === 'saveCmdPort') {
          const portNum = Number(message.port);
          if (Number.isFinite(portNum)) {
            await saveCmdPort(portNum);
          }
          return;
        }
        if (message && message.type === 'saveRemoteAddress') {
          const host = String(message.host || '').trim();
          if (host) {
            await saveRemoteAddress(host);
          }
          return;
        }
        if ("data" in message) {
          const { cmdUdpPort: currentCmdPort, remoteAddress: currentRemote } = getConfig();
          const udpClient = udp.createSocket('udp4');
          udpClient.send(message.data, 0, message.data.length, currentCmdPort, currentRemote || '127.0.0.1', () => {
            udpClient.close();
          });
          return;
        }
        if ("cmd" in message) {
          runCmd(message);
          return;
        }
      }, null, _disposables);
    })
  );

  const { udpPort, cmdUdpPort, remoteAddress } = getConfig();
  updateStatusBar(udpPort, cmdUdpPort, remoteAddress);
  statusBarIcon.show();
}

function runCmd(msg: any) {
  let id = ("id" in msg) ? msg.id : "";
  if (msg.cmd == "listSerialPorts") {
    SerialPort.list().then((ports: any) => {
      if (currentPanel) {
        currentPanel.webview.postMessage({ id, cmd: "serialPortList", list: ports });
      }
    });
  }
  else if (msg.cmd == "connectSerialPort") {
    if (serials[id]) { try { serials[id].close(); } catch { } delete serials[id]; }
    serials[id] = new SerialPort({ baudRate: msg.baud, path: msg.port }, function (err: any) {
      if (err) {
        currentPanel?.webview.postMessage({ id, cmd: "serialPortError", port: msg.port, baud: msg.baud });
      }
      else {
        currentPanel?.webview.postMessage({ id, cmd: "serialPortConnect", port: msg.port, baud: msg.baud });
      }
    });

    const parser = serials[id].pipe(new ReadlineParser({
      delimiter: ''
    }));
    parser.on('data', function (data: any) {
      currentPanel?.webview.postMessage({ id, data: data.toString(), fromSerial: true, timestamp: Date.now() });
    });
    serials[id].on('close', function (_err: any) {
      currentPanel?.webview.postMessage({ id, cmd: "serialPortDisconnect" });
    });
  }
  else if (msg.cmd == "sendToSerial") {
    serials[id]?.write(msg.text);
  }
  else if (msg.cmd == "disconnectSerialPort") {
    try { serials[id]?.close(); } catch { }
    delete serials[id];
  }
  else if (msg.cmd == "saveFile") {
    try {
      exportDataWithConfirmation(path.join(msg.file.name), { JSON: ["json"] }, msg.file.content);
    } catch (error: any) {
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
          void vscode.window.showErrorMessage("Could not write to file: " + value + ": " + error.message);
        } else {
          void vscode.window.showInformationMessage("Saved " + value);
        }
      });
    }
  });
}