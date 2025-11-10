// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile } from 'child_process';
import * as dgram from 'dgram';

import { SerialPort } from 'serialport';
import { ReadlineParser } from '@serialport/parser-readline';
// IP resolvido quando o endereço é .local (via mDNS 5353 ou fallback 3232)
let currentResolvedRemoteAddress: string | null = null;

// ===== Runtime state for UDP command target (not persisted) =====
let currentRemoteAddress: string = '0.0.0.0';
let currentCmdPort: number = 0;

// ===================== mDNS (UDP 5353) =========================
// Consulta mDNS minimalista (A record) para <host>.local, sem libs externas.
async function mdnsResolveA(hostLocal: string, timeoutMs = 1000): Promise<string | null> {
  if (!/\.local\.?$/i.test(hostLocal)) return null;

  const name = hostLocal.replace(/\.$/, '');
  const group = '224.0.0.251';
  const port = 5353;

  function buildQueryQName(qname: string): Buffer {
    const labels = qname.replace(/\.local$/i, '').split('.');
    const parts: Buffer[] = [];
    for (const lb of labels) {
      const b = Buffer.from(lb, 'utf8');
      if (!b.length || b.length > 63) continue;
      parts.push(Buffer.from([b.length]));
      parts.push(b);
    }
    parts.push(Buffer.from([5])); // "local"
    parts.push(Buffer.from('local', 'ascii'));
    parts.push(Buffer.from([0x00])); // terminador
    return Buffer.concat(parts);
  }

  function buildDnsQuery(host: string): Buffer {
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0x0000, 0); // ID
    header.writeUInt16BE(0x0000, 2); // Flags
    header.writeUInt16BE(0x0001, 4); // QDCOUNT = 1
    const qname = buildQueryQName(host);
    const qtype = Buffer.alloc(2); qtype.writeUInt16BE(0x0001, 0); // A
    const qclass = Buffer.alloc(2); qclass.writeUInt16BE(0x0001, 0); // IN
    return Buffer.concat([header, qname, qtype, qclass]);
  }

  function readName(buf: Buffer, offset: number): { name: string; next: number } {
    const labels: string[] = [];
    let i = offset, jumped = false, jumpEnd = -1;
    while (i < buf.length) {
      const len = buf[i];
      if (len === 0) { i += 1; break; }
      const isPtr = (len & 0xC0) === 0xC0;
      if (isPtr) {
        if (i + 1 >= buf.length) break;
        const ptr = ((len & 0x3F) << 8) | buf[i + 1];
        if (!jumped) { jumpEnd = i + 2; jumped = true; }
        i = ptr;
      } else {
        const end = i + 1 + len;
        if (end > buf.length) break;
        labels.push(buf.slice(i + 1, end).toString('utf8'));
        i = end;
      }
    }
    return { name: labels.join('.'), next: jumped ? jumpEnd : i };
  }

  function parseAAnswers(msg: Buffer): string[] {
    if (msg.length < 12) return [];
    let off = 12;
    const qdcount = msg.readUInt16BE(4);
    const ancount = msg.readUInt16BE(6);
    for (let q = 0; q < qdcount; q++) {
      const qn = readName(msg, off); off = qn.next;
      off += 4; // QTYPE + QCLASS
    }
    const ips: string[] = [];
    for (let a = 0; a < ancount; a++) {
      const an = readName(msg, off); off = an.next;
      if (off + 10 > msg.length) break;
      const type = msg.readUInt16BE(off); off += 2;
      /* const klass = */ off += 2;
      /* const ttl   = */ off += 4;
      const rdlen = msg.readUInt16BE(off); off += 2;
      const rdataEnd = off + rdlen;
      if (rdataEnd > msg.length) break;
      if (type === 0x0001 && rdlen === 4) {
        const ip = `${msg[off]}.${msg[off + 1]}.${msg[off + 2]}.${msg[off + 3]}`;
        ips.push(ip);
      }
      off = rdataEnd;
    }
    return ips;
  }

  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const query = buildDnsQuery(name);
  const answers: string[] = [];

  await new Promise<void>((resolve) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      try { sock.close(); } catch {}
      resolve();
    };

    sock.on('error', finish);
    sock.on('message', (msg) => {
      const ips = parseAAnswers(msg);
      for (const ip of ips) if (!answers.includes(ip)) answers.push(ip);
    });

    sock.on('listening', () => {
      try { sock.addMembership(group); } catch {}
      try { sock.setMulticastLoopback(true); } catch {}
      try { sock.setMulticastTTL(255); } catch {}
      sock.send(query, 0, query.length, port, group);
      setTimeout(() => sock.send(query, 0, query.length, port, group), 150);
      setTimeout(finish, timeoutMs);
    });

    sock.bind(0);
  });

  return answers[0] ?? null;
}
// ==============================================================
/**
 * Descobre IP via broadcast UDP 3232 (variações Arduino/ESP OTA costumam responder).
 * Tenta casar pelo hostname (sem .local) no payload; se não tiver, retorna o primeiro IP que respondeu.
 */
async function discoverOtaIpByUdp3232(targetHostLocal: string, timeoutMs = 1200): Promise<string | null> {
  const hostnameWanted = targetHostLocal.replace(/\.local\.?$/i, '').toLowerCase();
  const sock = dgram.createSocket('udp4');
  const responses: { ip: string; raw: string }[] = [];

  sock.on('listening', () => { try { sock.setBroadcast(true); } catch {} });

  sock.on('message', (msg, rinfo) => {
    const raw = msg.toString('utf8').trim();
    const ipMatch = raw.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
    const ip = ipMatch?.[1] || rinfo.address;
    responses.push({ ip, raw });
  });

  const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(0, () => resolve());
  });

  const probes = [Buffer.from('Arduino'), Buffer.from('DISCOVER')];
  for (const p of probes) {
    try { sock.send(p, 3232, '255.255.255.255'); } catch {}
    await wait(120);
  }

  await wait(timeoutMs);
  try { sock.close(); } catch {}

  if (!responses.length) return null;
  const byHost = responses.find(r => r.raw.toLowerCase().includes(hostnameWanted));
  return byHost ? byHost.ip : responses[0].ip || null;
}

async function resolveLocalHostPreferMdnsThenOta(hostLocal: string): Promise<string | null> {
  // 1) mDNS (5353)
  const ipMdns = await mdnsResolveA(hostLocal, 1000);
  if (ipMdns) return ipMdns;

  // 2) fallback OTA/UDP 3232
  const ipOta = await discoverOtaIpByUdp3232(hostLocal, 1200);
  return ipOta;
}

function getLocalIPv4(): string {
  try {
    const nets = os.networkInterfaces() as Record<string, os.NetworkInterfaceInfo[]>;
    for (const name of Object.keys(nets)) {
      const arr = nets[name] || [];
      for (const n of arr) {
        if ((n as any).family === 'IPv4' && !(n as any).internal && (n as any).address) {
          return String((n as any).address);
        }
      }
    }
  } catch {}
  return '127.0.0.1';
}

// ================== CONFIG ==================
const CONFIG_NS = 'lasecplot';
const CFG_UDP_PORT = 'udpPort';

// ================== TIPOS AUX ==================
type PortInfoLite = {
  path: string;              // COMx ou /dev/tty...
  friendlyName?: string;     // texto útil para exibir
  manufacturer?: string;
  pnpId?: string;
  serialNumber?: string;
  locationId?: string;
  productId?: string;
  vendorId?: string;
  deviceLocation?: string;
  devicePath?: string;       // \Device\Serial0 (no Windows / Registro)
  isVirtual?: boolean;       // heurística
  _source?: string;          // debug: SERIALCOMM, serialport, merge
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
  const udpPort = cfg.get<number>(CFG_UDP_PORT, 47269);
  const localIP = getLocalIPv4();
  return { cfg, udpPort, localIP };
}

function updateStatusBar(udpPort: number, localIP: string) {
  if (!statusBarIcon) return;
  statusBarIcon.text = `$(graph-line) LasecPlot`;
  statusBarIcon.tooltip = `UDP-Receive: ${localIP}:${udpPort}`;
  statusBarIcon.show();
}

function bindUdpServer(udpPort: number, localIP: string) {
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
  updateStatusBar(udpPort, localIP);
}

async function saveAddressPort(address: string, port: number) {
  // Deprecated: no longer persisting remote address; only update local udpPort if changed.
  const { cfg, udpPort, localIP } = getConfig();
  if (udpPort !== port) {
    await cfg.update(CFG_UDP_PORT, port, vscode.ConfigurationTarget.Global);
    bindUdpServer(port, localIP);
  } else {
    updateStatusBar(udpPort, localIP);
  }
} 

// async function saveCmdPort(port: number) {
//   const { cfg, udpPort, cmdUdpPort } = getConfig();
//   if (cmdUdpPort !== port) {
//     await cfg.update(CFG_CMD_UDP_PORT, port, vscode.ConfigurationTarget.Global);
//     updateStatusBar(udpPort, port);
//   }
// }

// ================== ATIVAÇÃO ==================
export function activate(context: vscode.ExtensionContext) {
  statusBarIcon = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarIcon.command = 'lasecplot.start';
  context.subscriptions.push(statusBarIcon);

  context.subscriptions.push(
    vscode.commands.registerCommand('lasecplot.start', () => {
      const { udpPort, localIP } = getConfig();
      bindUdpServer(udpPort, localIP);

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

        // Reescrever src/href para URIs do webview
        const srcList = rawHTML.match(/src="(.*?)"/g) ?? [];
        const hrefList = rawHTML.match(/href="(.*?)"/g) ?? [];
        for (const attr of [...srcList, ...hrefList]) {
          const url = attr.split('"')[1];
          const extensionURI = vscode.Uri.joinPath(context.extensionUri, "./media/" + url);
          const webURI = panel.webview.asWebviewUri(extensionURI);
          const toReplace = attr.replace(url, webURI.toString());
          rawHTML = rawHTML.replace(attr, toReplace);
        }

        // Força estilo dark se existir marcador
        const lasecplotStyle = rawHTML.match(/(.*)_lasecplot_default_color_style(.*)/g);
        if (lasecplotStyle != null) {
          rawHTML = rawHTML.replace(lasecplotStyle.toString(), 'var _lasecplot_default_color_style = "dark";');
        }

        panel.webview.html = rawHTML;

        // Envia config inicial
        panel.webview.postMessage({
          type: 'initConfig',
          localIP,
          udpPort,
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
        // if (message?.type === 'saveCmdPort') {
        //   const portNum = Number(message.port);
        //   if (Number.isFinite(portNum)) {
        //     await saveCmdPort(portNum);
        //   }
        //   return;
        // }

        // efetivar conexão de comando (udp.connect)
        if (message?.type === 'udp.connect') {
          const host = String(message.remoteAddress || '').trim();
          const portNum = Number(message.cmdUdpPort);

          if (host && Number.isFinite(portNum) && portNum > 0) {
            // mantém o que o usuário digitou para a UI
            currentRemoteAddress = host;
            currentCmdPort = portNum;
            currentResolvedRemoteAddress = null;

            if (/\.local\.?$/i.test(host)) {
              try {
                const ip = await resolveLocalHostPreferMdnsThenOta(host);
                if (ip) {
                  currentResolvedRemoteAddress = ip;
                  console.log(`[resolve] ${host} → ${ip} (mDNS/3232)`);
                } else {
                  console.warn(`[resolve] Sem resposta para ${host}; usando o host como está.`);
                }
              } catch (e) {
                console.warn(`[resolve] Erro ao resolver ${host}:`, e);
              }
            }

            // Handshake CONNECT:<localIP>:<udpPort> usando IP se houver
            try {
              const udpClient = dgram.createSocket('udp4');
              const { udpPort, localIP } = getConfig(); // seu helper existente
              const payload = Buffer.from(`CONNECT:${localIP}:${udpPort}`);
              const targetHost = currentResolvedRemoteAddress ?? currentRemoteAddress;
              udpClient.send(payload, 0, payload.length, currentCmdPort, targetHost, () => {
                udpClient.close();
              });
            } catch (e) {
              console.error('UDP CONNECT handshake error:', e);
            }
          }
          return;
        }


        // efetivar desconexão de comando (udp.disconnect)
        if (message?.type === 'udp.disconnect') {
          const host = String(message.remoteAddress || '').trim();
          const portNum = Number(message.cmdUdpPort);
          if (host && Number.isFinite(portNum) && portNum > 0) {
            // Envia handshake DISCONNECT:<localIP>:<udpPort> para o remoto
            try {
              const udpClient = dgram.createSocket('udp4');
              const { udpPort, localIP } = getConfig();
              const payload = Buffer.from(`DISCONNECT:${localIP}:${udpPort}`);
              udpClient.send(payload, 0, payload.length, portNum, host, () => {
                udpClient.close();
              });
            } catch (e) {
              console.error('UDP CONNECT handshake error:', e);
            }
          }
          return;
        }

        // enviar payload para endereço/porta de comando
        if ('data' in message) {
          const addr = currentResolvedRemoteAddress ?? currentRemoteAddress;
          const portToUse = currentCmdPort;
          const buf: Buffer = Buffer.isBuffer(message.data)
            ? message.data
            : Buffer.from(String(message.data));
          const udpClient = dgram.createSocket('udp4');
          udpClient.send(buf, 0, buf.length, portToUse || 0, (addr && addr !== '0.0.0.0') ? addr : '127.0.0.1', () => {
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

  const { udpPort, localIP } = getConfig();
  updateStatusBar(udpPort, localIP);
  statusBarIcon.show();
}

// ================== COMANDOS / SERIAL ==================
function runCmd(msg: any) {
  const id: string = ('id' in msg) ? msg.id : '';

  if (msg.cmd === 'listSerialPorts') {
    listSerialPortsMerged().then((ports) => {
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: ports });
    }).catch(async (err) => {
      console.warn('[serial] merged list failed, fallback SerialPort.list():', err);
      try {
        const base = await SerialPort.list();
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: base });
      } catch (e) {
        console.error('[serial] total list failure:', e);
        currentPanel?.webview.postMessage({ id, cmd: 'serialPortList', list: [] });
      }
    });
    return;
  }
  else if (msg.cmd === 'connectSerialPort') {
    if (serials[id]) {
      try { serials[id].close(); } catch { /* ignore */ }
      delete serials[id];
    }

    const requestedPath: string = String(msg.port || '');
    const baud: number = Number(msg.baud || 115200);

    const openPath = normalizeWindowsPathForOpen(requestedPath);

    const sp = new SerialPort({ path: openPath, baudRate: baud });
    serials[id] = sp;

    sp.on('open', () => {
      console.log('[serial] open', openPath);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortConnect', port: requestedPath, baud });
    });
    sp.on('error', (err) => {
      console.log('[serial] error', err);
      currentPanel?.webview.postMessage({ id, cmd: 'serialPortError', port: requestedPath, baud });
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
    serials[id]?.write(String(msg.text ?? ''));
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

// ================== LISTA DE PORTAS (MERGE) ==================
async function listSerialPortsMerged(): Promise<PortInfoLite[]> {
  // Base do serialport (existe em todas as plataformas)
  const spList = await SerialPort.list();

  if (os.platform() !== 'win32') {
    // Fora do Windows, retorna direto
    return sortPorts(spList.map(mapFromSerialport));
  }

  // No Windows: ler Registro e mesclar
  const regList = await listSerialPortsFromRegistry();
  const byKey = new Map<string, PortInfoLite>();

  // Começa pelo Registro (prioriza o que o SO diz)
  for (const r of regList) {
    const k = String(r.path || '').toUpperCase();
    if (!k) continue;
    byKey.set(k, { ...r, _source: 'SERIALCOMM' });
  }

  // Enriquecer/mesclar com SerialPort.list()
  for (const p of spList) {
    const pp = mapFromSerialport(p);
    const k = String(pp.path || '').toUpperCase();
    if (!k) continue;
    if (byKey.has(k)) {
      const merged = { ...pp, ...byKey.get(k) };
      merged.isVirtual = inferVirtualFromStrings(
        merged.friendlyName, merged.pnpId, merged.manufacturer, merged.devicePath
      );
      merged._source = 'SERIALCOMM+serialport';
      byKey.set(k, merged);
    } else {
      byKey.set(k, { ...pp, _source: 'serialport' });
    }
  }

  return sortPorts(Array.from(byKey.values()));
}

function mapFromSerialport(p: any): PortInfoLite {
  return {
    path: p.path,
    friendlyName: p.friendlyName ?? p.path,
    manufacturer: p.manufacturer,
    pnpId: p.pnpId,
    serialNumber: p.serialNumber,
    locationId: p.locationId,
    productId: p.productId,
    vendorId: p.vendorId
  };
}

function sortPorts(arr: PortInfoLite[]): PortInfoLite[] {
  const out = [...arr];
  out.sort((a, b) => {
    const na = parseInt(String(a.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    const nb = parseInt(String(b.path || '').replace(/[^0-9]/g, ''), 10) || 0;
    return na - nb;
  });
  return out;
}

// ================== WINDOWS: Registro SERIALCOMM ==================
async function listSerialPortsFromRegistry(): Promise<PortInfoLite[]> {
  const out: PortInfoLite[] = [];
  try {
    const args = ['query', 'HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM'];
    const stdout = await execReg(args);
    const lines = String(stdout || '').split(/\r?\n/);

    for (const line of lines) {
      if (!/REG_SZ/i.test(line)) continue;
      // Formato: "<Nome>   REG_SZ   <Dados>"
      const parts = line.trim().split(/\s{2,}|\t+/).filter(Boolean);
      if (parts.length >= 3) {
        const devicePath = parts[0];
        const dataCol = (parts[2] || '').trim(); // geralmente "COMx" ou "CNCA0" etc.

        // Só COMx é abrível diretamente (outros nomes são aliases; listamos mesmo assim)
        if (/^COM\d+$/i.test(dataCol)) {
          out.push({
            path: dataCol.toUpperCase(),
            friendlyName: devicePath,
            devicePath
          });
        } else {
          // Mantemos para visualização (e permitir abrir via \\.\NOME se usuário quiser)
          out.push({
            path: dataCol, // ex.: "CNCA0"
            friendlyName: devicePath,
            devicePath
          });
        }
      }
    }
  } catch (e) {
    console.warn('[serial] registry read failed:', e);
  }

  // de-dup por path
  const uniq = new Map<string, PortInfoLite>();
  for (const p of out) uniq.set(String(p.path || '').toUpperCase(), p);
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

// ================== WINDOWS: Normalização para abrir ==================
function normalizeWindowsPathForOpen(requested: string): string {
  if (os.platform() !== 'win32') return requested;

  const port = String(requested || '').trim();
  if (!port) return port;

  // COM1..COM9: pode abrir como está.
  const m = /^COM(\d+)$/i.exec(port);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 9) return `COM${n}`;
    // COM10+ precisa \\.\COM10
    return `\\\\.\\${port}`;
  }

  // Qualquer outro nome (ex.: CNCA0, dispositivos com nome extenso) => \\.\NOME
  if (!port.startsWith('\\\\.\\')) {
    return `\\\\.\\${port}`;
  }
  return port;
}

// ================== DESATIVAÇÃO ==================
export function deactivate() {
  try { udpServer?.close(); } catch { /* ignore */ }
  for (const k in serials) {
    try { serials[k].close(); } catch { /* ignore */ }
  }
}