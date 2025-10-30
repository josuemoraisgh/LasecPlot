import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ReadlineParser } from 'serialport';
const { SerialPort } = require('serialport');
const Readline = require('@serialport/parser-readline');
const udp = require('dgram');

// ================== CONFIGURAÇÃO ==================
const CONFIG_NS = 'lasecplot';
const CFG_UDP_ADDRESS = 'udpAddress';
const CFG_UDP_PORT = 'udpPort';
const CFG_CMD_UDP_PORT = 'cmdUdpPort';

// ================== ESTADO GLOBAL ==================
let serials: Record<string, any> = {};
let udpServer: any = null;
let currentPanel: vscode.WebviewPanel | null = null;
let _disposables: vscode.Disposable[] = [];
let statusBarIcon: vscode.StatusBarItem;

// Leitura centralizada das settings atuais
function getConfig() {
  const cfg = vscode.workspace.getConfiguration(CONFIG_NS);
  const udpAddress = cfg.get<string>(CFG_UDP_ADDRESS, '');
  const udpPort = cfg.get<number>(CFG_UDP_PORT, 47269);
  const cmdUdpPort = cfg.get<number>(CFG_CMD_UDP_PORT, 47268);
  return { cfg, udpAddress, udpPort, cmdUdpPort };
}

// Atualiza StatusBar
function updateStatusBar(udpPort: number, cmdUdpPort: number) {
  if (!statusBarIcon) return;
  statusBarIcon.text = `$(graph-line) LasecPlot`;
  statusBarIcon.show();
}

// (Re)inicia o servidor UDP na porta informada
function bindUdpServer(udpPort: number, cmdUdpPort: number) {
  // Fecha servidor antigo
  if (udpServer) {
    try { udpServer.close(); } catch { /* ignore */ }
    udpServer = null;
  }
  // Cria novo
  udpServer = udp.createSocket('udp4');
  udpServer.bind(udpPort);
  // Encaminha mensagens UDP -> Webview
  udpServer.on('message', function (msg: any, _info: any) {
    if (currentPanel) {
      currentPanel.webview.postMessage({ data: msg.toString(), fromSerial: false, timestamp: Date.now() });
    }
  });
  updateStatusBar(udpPort, cmdUdpPort);
}

// Salva endereço/porta de dados e reconfigura servidor UDP se necessário
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

// Salva porta de comando (cmdUdpPort)
async function saveCmdPort(port: number) {
  const { cfg, udpPort, cmdUdpPort } = getConfig();
  if (cmdUdpPort !== port) {
    await cfg.update(CFG_CMD_UDP_PORT, port, vscode.ConfigurationTarget.Global);
    // Não é necessário rebind do servidor de dados; só atualiza StatusBar
    updateStatusBar(udpPort, port);
  }
}

// ================== ATIVAÇÃO DA EXTENSÃO ==================
export function activate(context: vscode.ExtensionContext) {
  // StatusBar
  statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarIcon.command = 'lasecplot.start';
  context.subscriptions.push(statusBarIcon);

  // Comando principal
  context.subscriptions.push(
    vscode.commands.registerCommand('lasecplot.start', () => {
      const { udpAddress, udpPort, cmdUdpPort } = getConfig();

      // Sobe/ajusta servidor UDP conforme settings
      bindUdpServer(udpPort, cmdUdpPort);

      const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

      // Se já existe painel, apenas revela
      if (currentPanel) {
        currentPanel.reveal(column);
        return;
      }

      // Cria Webview novo
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

      // Carrega index.html, reescreve src/href para URIs do Webview e injeta estilo default
      fs.readFile(path.join(context.extensionPath, 'media', 'index.html'), (err, data) => {
        if (err) { console.error(err); return; }
        let rawHTML = data.toString();

        const srcList = rawHTML.match(/src\=\"(.*?)\"/g) || [];
        const hrefList = rawHTML.match(/href\=\"(.*?)\"/g) || [];

        for (let attr of [...srcList, ...hrefList]) {
          const url = attr.split('"')[1];
          const extensionURI = vscode.Uri.joinPath(context.extensionUri, "./media/" + url);
          const webURI = panel.webview.asWebviewUri(extensionURI);
          const toReplace = attr.replace(url, webURI.toString());
          rawHTML = rawHTML.replace(attr, toReplace);
        }

        // Força estilo "dark" por padrão, se houver marcador no HTML
        const lasecplotStyle = rawHTML.match(/(.*)_lasecplot_default_color_style(.*)/g);
        if (lasecplotStyle != null) {
          rawHTML = rawHTML.replace(lasecplotStyle.toString(), 'var _lasecplot_default_color_style = "dark";');
        }

        panel.webview.html = rawHTML;

        // Envia config inicial para o Webview (para preencher campos/estado)
        panel.webview.postMessage({
          type: 'initConfig',
          udpAddress,
          udpPort,
          cmdUdpPort,
        });
      });

      // Dispose do painel
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
        for (let s in serials) {
          try { serials[s].close(); } catch { /* ignore */ }
          serials[s] = null;
        }
        currentPanel = null;
      }, null, _disposables);

      // Recebe mensagens do Webview
      panel.webview.onDidReceiveMessage(async (message) => {
        // 1) Salvamento de endereço/porta de dados vindo da UI
        if (message && message.type === 'saveAddressPort') {
          const host = String(message.host || '').trim();
          const portNum = Number(message.port);
          if (host && Number.isFinite(portNum)) {
            await saveAddressPort(host, portNum);
          }
          return;
        }

        // 2) (Opcional) Salvamento da porta de comando
        if (message && message.type === 'saveCmdPort') {
          const portNum = Number(message.port);
          if (Number.isFinite(portNum)) {
            await saveCmdPort(portNum);
          }
          return;
        }

        // 3) Encaminhamento de dados para UDP comando (usa cmdUdpPort/udpAddress das settings)
        if ("data" in message) {
          const { udpAddress, cmdUdpPort: currentCmdPort } = getConfig();
          const buf: Buffer = Buffer.isBuffer(message.data) ? message.data : Buffer.from(String(message.data));
          const udpClient = udp.createSocket('udp4');
          udpClient.send(buf, 0, buf.length, currentCmdPort, udpAddress || '127.0.0.1', () => {
            udpClient.close();
          });
          return;
        }

        // 4) Comandos gerais
        if ("cmd" in message) {
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

// ================== LÓGICA SERIAL/COMANDOS ==================
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
    if (serials[id]) { // Já existe
      try { serials[id].close(); } catch { /* ignore */ }
      delete serials[id];
    }
    serials[id] = new SerialPort({ baudRate: msg.baud, path: msg.port }, function (err: any) {
      if (err) {
        console.log("serial error");
        currentPanel?.webview.postMessage({ id, cmd: "serialPortError", port: msg.port, baud: msg.baud });
      }
      else {
        console.log("serial open");
        currentPanel?.webview.postMessage({ id, cmd: "serialPortConnect", port: msg.port, baud: msg.baud });
      }
    });

    const parser = serials[id].pipe(new ReadlineParser({ delimiter: '\n' }));
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
    try { serials[id]?.close(); } catch { /* ignore */ }
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
          void vscode.window.showErrorMessage("Could not write to file: " + value + ": " + error.message);
        } else {
          void vscode.window.showInformationMessage("Saved " + value);
        }
      });
    }
  });
}