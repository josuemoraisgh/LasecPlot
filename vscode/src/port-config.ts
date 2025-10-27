import * as fs from 'fs';
import * as path from 'path';

export type Ports = { udp: number; cmd: number };

function parseIni(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('[')) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (m) out[m[1].toUpperCase()] = m[2].trim(); // normaliza para MAIÚSCULAS
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

function asValidPort(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v as number;
  return (Number.isInteger(n) && (n as number) > 0 && (n as number) < 65536) ? (n as number) : null;
}

/**
 * Procura teleplot-ports.ini em:
 *  1) workspace raiz (process.cwd())
 *  2) diretório da extensão em dev (../teleplot-ports.ini)
 *  3) empacotado (../../teleplot-ports.ini)
 * Também permite override por env: TELEPLOT_UDP_PORT / TELEPLOT_CMD_UDP_PORT
 */
export function getPorts(defaultUdp = 47269, defaultCmd = 47268): Ports {
  const candidates = [
    path.resolve(process.cwd(), 'teleplot-ports.ini'),
    path.resolve(__dirname, '..', 'teleplot-ports.ini'),
    path.resolve(__dirname, '..', '..', 'teleplot-ports.ini'),
  ];

  // env tem prioridade
  const envUdp = asValidPort(process.env.TELEPLOT_UDP_PORT);
  const envCmd = asValidPort(process.env.TELEPLOT_CMD_UDP_PORT);

  let cfg: Record<string, string> | null = null;
  for (const p of candidates) {
    cfg = readIniIfExists(p);
    if (cfg) break;
  }

  let udp = envUdp ?? defaultUdp;
  let cmd = envCmd ?? defaultCmd;

  if (cfg) {
    // aceita UDP_PORT e CMD_UDP_PORT; também variações comuns
    const pick = (...keys: string[]) => {
      for (const k of keys) {
        const v = cfg![k.toUpperCase()];
        const n = asValidPort(v);
        if (n !== null) return n;
      }
      return null;
    };
    udp = pick('UDP_PORT', 'TELEPLOT.UDP_PORT', 'UDP.PORT') ?? udp;
    cmd = pick('CMD_UDP_PORT', 'TELEPLOT.CMD_UDP_PORT', 'RPC_PORT', 'RPC.PORT') ?? cmd;
  }

  return { udp, cmd };
}
