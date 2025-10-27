import * as fs from 'fs';
import * as path from 'path';

export type Ports = { udp: number; rpc: number };

function parseIni(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (m) out[m[1].toLowerCase()] = m[2].trim();
  }
  return out;
}

function readIniIfExists(p: string): Record<string, string> | null {
  try {
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      return parseIni(txt);
    }
  } catch {}
  return null;
}

/**
 * Procura readme.ini em:
 *  - workspace raiz (process.cwd())
 *  - diretório da extensão (ao lado do package.json compilado)
 */
export function getPorts(defaultUdp = 47269, defaultRpc = 47268): Ports {
  const candidates = [
    path.resolve(process.cwd(), 'readme.ini'),
    path.resolve(__dirname, '..', 'readme.ini'),          // durante dev
    path.resolve(__dirname, '..', '..', 'readme.ini'),    // empacotado
  ];

  let cfg: Record<string, string> | null = null;
  for (const p of candidates) {
    cfg = readIniIfExists(p);
    if (cfg) break;
  }

  let udp = defaultUdp;
  let rpc = defaultRpc;

  if (cfg) {
    // aceita UDP_PORT / udp_port / teleplot.udp_port
    const getNum = (keys: string[]): number | null => {
      for (const k of keys) {
        const v = cfg![k];
        if (!v) continue;
        const n = Number(v);
        if (Number.isInteger(n) && n > 0 && n < 65536) return n;
      }
      return null;
    };
    udp = getNum(['udp_port', 'teleplot.udp_port', 'udp.port']) ?? udp;
    rpc = getNum(['rpc_port', 'teleplot.rpc_port', 'rpc.port']) ?? rpc;
  }

  return { udp, rpc };
}
