# udp_min_test.py
import socket, time, math
DEST_IP = "10.13.1.5"   # coloque exatamente o que aparece em "UDP-Receive"
DEST_PORT = 47269

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
t0 = time.time()
while True:
    t = time.time() - t0
    val = math.sin(2*math.pi*1.0*t)
    ts  = int(time.time()*1000)
    line = f">sin:{ts}:{val}|g\n"  # unitário, retrocompat total
    sock.sendto(line.encode("utf-8"), (DEST_IP, DEST_PORT))
    time.sleep(0.05)  # ~20 Hz
