#!/usr/bin/env python3
import argparse
import math
import socket
import threading
import time
import signal
import sys
from typing import Optional, Tuple

def get_local_ip(to_ip: str, fallback: str = "127.0.0.1") -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect((to_ip, 9))
            return s.getsockname()[0]
    except Exception:
        return fallback

class UdpSineServer:
    """
    Protocolo:
      Cliente -> Servidor (cmd_port): "CONNECT:<CLIENT_LOCAL_IP>:<CLIENT_UDP_PORT>"
      Servidor -> Cliente (<CLIENT_LOCAL_IP>, <CLIENT_UDP_PORT>): "CONNECTED:<SERVER_IP>:<CMD_PORT>"
      Servidor -> Cliente (<CLIENT_LOCAL_IP>, <CLIENT_UDP_PORT>): "><var>:<ts_ms>:<valor>\n"
    """
    def __init__(self, cmd_port=47268, sine_freq_hz=1.0, send_rate_hz=30.0, amplitude=1.0, var_name="sin", verbose=True):
        self.cmd_port = int(cmd_port)
        self.sine_freq_hz = float(sine_freq_hz)
        self.send_rate_hz = max(1.0, min(float(send_rate_hz), 200.0))
        self.amplitude = float(amplitude)
        self.var_name = str(var_name)
        self.verbose = bool(verbose)

        self._stop = threading.Event()
        self._target_lock = threading.Lock()
        self._data_target: Optional[Tuple[str, int]] = None  # (ip, port)

        # sockets
        self.cmd_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.cmd_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.cmd_sock.bind(("0.0.0.0", self.cmd_port))
        self.data_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

        self._tx_thread = threading.Thread(target=self._tx_loop, daemon=True)

    def start(self):
        print(f"[CMD] Escutando CONNECT em 0.0.0.0:{self.cmd_port}")
        self._tx_thread.start()
        try:
            while not self._stop.is_set():
                try:
                    self.cmd_sock.settimeout(0.5)
                    data, addr = self.cmd_sock.recvfrom(4096)
                except socket.timeout:
                    continue
                except ConnectionResetError as e:
                    # Windows: ICMP Port Unreachable vira WSAECONNRESET em recvfrom
                    if self.verbose:
                        print(f"[CMD] Aviso (ConnectionReset): {e}")
                    continue

                msg = data.decode("utf-8", errors="ignore").strip()
                if self.verbose:
                    print(f"[CMD] De {addr}: {msg}")

                if not msg.startswith("CONNECT:"):
                    continue

                parts = msg.split(":")
                if len(parts) != 3:
                    print("[CMD] Formato CONNECT inválido. Esperado: CONNECT:<IP_LOCAL>:<UDP_PORT>")
                    continue

                client_ip = parts[1].strip()
                try:
                    client_port = int(parts[2])
                except ValueError:
                    print("[CMD] Porta inválida no CONNECT")
                    continue

                server_ip = get_local_ip(client_ip)
                ok = f"CONNECTED:{server_ip}:{self.cmd_port}"

                # OK vai para a porta de DADOS do cliente
                try:
                    self.data_sock.sendto(ok.encode("utf-8"), (client_ip, client_port))
                    if self.verbose:
                        print(f"[CMD] >> {ok} para {(client_ip, client_port)}")
                except Exception as e:
                    print(f"[CMD] Falha ao enviar OK: {e}")

                # define/atualiza destino de dados
                with self._target_lock:
                    self._data_target = (client_ip, client_port)

        finally:
            self.stop()

    def _tx_loop(self):
        dt = 1.0 / self.send_rate_hz
        t0 = time.time()
        sent = 0
        last_log = time.time()

        while not self._stop.is_set():
            # lê destino atual
            with self._target_lock:
                target = self._data_target

            if target is None:
                # ninguém conectou ainda — só espera um pouquinho
                time.sleep(0.05)
                continue

            # gera amostra
            t = time.time() - t0
            value = self.amplitude * math.sin(2.0 * math.pi * self.sine_freq_hz * t)
            ts_ms = int(time.time() * 1000)

            line = f">{self.var_name}:{ts_ms}:{value}|g\n"
            try:
                self.data_sock.sendto(line.encode("utf-8"), target)
                sent += 1
            except Exception as e:
                print(f"[TX] Erro ao enviar para {target}: {e}")
                time.sleep(0.2)

            # log de saúde do envio (1x/seg)
            now = time.time()
            if self.verbose and (now - last_log) >= 1.0:
                print(f"[TX] destino={target} rate≈{sent/(now-last_log):.1f} msg/s  último_ts={ts_ms}")
                sent = 0
                last_log = now

            # espera para manter a taxa
            target_dt = dt - 0.001  # pequena folga
            if target_dt > 0:
                time.sleep(target_dt)

        if self.verbose:
            print("[TX] Loop encerrado")

    def stop(self):
        self._stop.set()
        try:
            if self._tx_thread.is_alive():
                self._tx_thread.join(timeout=2.0)
        except Exception:
            pass
        for s in (self.cmd_sock, self.data_sock):
            try:
                s.close()
            except Exception:
                pass

def main():
    import argparse
    ap = argparse.ArgumentParser(description="Servidor UDP (handshake + seno) para LasecPlot")
    ap.add_argument("--cmd-port", type=int, default=47268, help="CMD_UDP_PORT (porta de comandos) [default: 47268]")
    ap.add_argument("--freq", type=float, default=1.0, help="Frequência do seno (Hz) [default: 1.0]")
    ap.add_argument("--rate", type=float, default=30.0, help="Taxa de envio (Hz) [default: 30.0]")
    ap.add_argument("--amp", type=float, default=1.0, help="Amplitude do seno [default: 1.0]")
    ap.add_argument("--var", type=str, default="sin", help="Nome da variável [default: sin]")
    ap.add_argument("--quiet", action="store_true", help="Menos logs")
    args = ap.parse_args()

    srv = UdpSineServer(
        cmd_port=args.cmd_port,
        sine_freq_hz=args.freq,
        send_rate_hz=args.rate,
        amplitude=args.amp,
        var_name=args.var,
        verbose=not args.quiet,
    )

    def _sigint(_sig, _frm):
        print("\n[SIGINT] Encerrando…")
        srv.stop()
        sys.exit(0)

    signal.signal(signal.SIGINT, _sigint)
    try:
        srv.start()
    except KeyboardInterrupt:
        _sigint(None, None)

if __name__ == "__main__":
    main()
