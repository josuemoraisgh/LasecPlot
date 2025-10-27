
import * as vscode from 'vscode';
import * as dgram from 'dgram';
import { randomUUID } from 'crypto';

type Target = { ip: string, port: number } | null;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('LasecPlot UDP');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = `LasecPlot: UDP Not connected`;
  status.tooltip = 'Clique para abrir o painel Teleplot';
  status.command = 'lasecplot.openSidebar';
  status.show();
  context.subscriptions.push(status);

  // Settings
  const getUdpPort = () => vscode.workspace.getConfiguration('lasecplot').get<number>('udpPort', 47269);
  const getCmdPort = () => vscode.workspace.getConfiguration('lasecplot').get<number>('cmdUdpPort', 47268);

  // Sockets
  let listenSocket: dgram.Socket | null = null;
  let sendSocket: dgram.Socket | null = null;
  let target: Target = null;
  const clientId = context.globalState.get<string>('clientId') || randomUUID();
  context.globalState.update('clientId', clientId);

  function setTarget(t: Target){
    target = t;
    context.globalState.update('lastTarget', t ? `${t.ip}:${t.port}` : '');
    updateStatus(false);
  }
  function updateStatus(connected: boolean){
    status.text = connected && target ? `LasecPlot UDP: ${target.ip}:${target.port}` : 'LasecPlot: UDP Not connected';
    if(panelView){
      panelView.webview.postMessage({type:'status', connected, target: target ? `${target.ip}:${target.port}` : ''});
    }
  }

  function ensureSockets(){
    if(!sendSocket){
      sendSocket = dgram.createSocket('udp4');
      context.subscriptions.push({dispose: ()=>sendSocket?.close()});
    }
    const port = getUdpPort();
    if(!listenSocket){
      listenSocket = dgram.createSocket('udp4');
      listenSocket.on('error', (err)=>{
        output.appendLine(`[listen:error] ${err.message}`);
      });
      listenSocket.on('message', (msg, rinfo)=>{
        // filter by target ip and configured udpPort
        if(target && rinfo.address === target.ip && rinfo.port === getUdpPort()){
          const text = msg.toString('utf8');
          output.appendLine(`[udp ${rinfo.address}:${rinfo.port}] ${text.trim()}`);
          panelView?.webview.postMessage({type:'udpData', text});
          panelView?.webview.postMessage({type:'log', text});
          // TODO: despachar para parser de gráfico, se existir
        } else {
          // Ignora mensagens que não são do alvo esperado
        }
      });
      listenSocket.bind(port, ()=>{
        output.appendLine(`[listen] Bind UDP ${port}`);
      });
      context.subscriptions.push({dispose: ()=>listenSocket?.close()});
    } else {
      // rebind if port changed
      const addr = listenSocket.address();
      if(typeof addr === 'object' && addr.port !== port){
        try { listenSocket.close(); } catch {}
        listenSocket = null;
        ensureSockets();
      }
    }
  }
  ensureSockets();

  // Sidebar View
  let panelView: vscode.WebviewView | null = null;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('lasecplot.teleplotSidebar', {
      resolveWebviewView(webviewView: vscode.WebviewView) {
        panelView = webviewView;
        webviewView.webview.options = { enableScripts: true };
        const nonce = `${Date.now()}`;
        const html = getWebviewHtml(webviewView.webview, context, nonce);
        webviewView.webview.html = html;
        const last = context.globalState.get<string>('lastTarget','');
        webviewView.webview.postMessage({type:'preset', ip: last ? last.split(':')[0] : ''});
        updateStatus(!!target);

        webviewView.webview.onDidReceiveMessage((msg)=>{
          switch(msg.type){
            case 'connect': {
              const raw: string = (msg.ip || '').trim();
              if(!raw){ vscode.window.showWarningMessage('Informe um IP válido.'); return; }
              let ip = raw;
              let port = getCmdPort();
              if(raw.includes(':')){
                const [a,b] = raw.split(':');
                ip = a;
                const p = Number(b);
                if(!Number.isNaN(p) && p>0 && p<65536) port = p;
              }
              setTarget({ip, port});
              ensureSockets();
              // send CONNECT <clientId>\n
              try {
                const payload = Buffer.from(`CONNECT ${clientId}\n`, 'utf8');
                sendSocket!.send(payload, port, ip);
                updateStatus(true);
                panelView?.webview.postMessage({type:'log', text: `[send] CONNECT ${clientId}`});
              } catch(e:any){
                vscode.window.showErrorMessage('Falha ao enviar CONNECT: ' + e.message);
                updateStatus(false);
              }
              break;
            }
            case 'cancel': {
              setTarget(null);
              updateStatus(false);
              break;
            }
            case 'send': {
              if(!target){ vscode.window.showWarningMessage('Defina o IP e conecte antes de enviar.'); return; }
              const text: string = String(msg.text ?? '');
              if(!text) return;
              const payload = Buffer.from(text + '\n', 'utf8');
              try{
                sendSocket!.send(payload, target.port, target.ip);
                panelView?.webview.postMessage({type:'log', text: `[send] ${text}`});
              }catch(e:any){
                vscode.window.showErrorMessage('Falha ao enviar: ' + e.message);
              }
              break;
            }
          }
        });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('lasecplot.openSidebar', ()=>{
      vscode.commands.executeCommand('workbench.view.extension.lasecplot');
    })
  );

  vscode.workspace.onDidChangeConfiguration(e=>{
    if(e.affectsConfiguration('lasecplot.udpPort')){
      ensureSockets();
    }
  });
}

function getWebviewHtml(webview: vscode.Webview, context: vscode.ExtensionContext, nonce: string){
  const tpl = require('fs').readFileSync(context.asAbsolutePath('media/teleplot.html'), 'utf8');
  return tpl.replace('{{nonce}}', nonce);
}

export function deactivate(){}
