#ifndef __WSERIAL_H
#define __WSERIAL_H
#include <Arduino.h>
#include <WiFi.h>
#include <AsyncUDP.h>

#define BAUD_RATE 115200
#define NEWLINE "\r\n"

// Protocolo UDP (lado dispositivo):
// 1) LasecPlot -> CMD_UDP_PORT:  "CONNECT:<IP_LOCAL_DO_VSCODE>:<UDP_PORT_VSCODE>"
// 2) Dispositivo -> (<IP_LOCAL>,<UDP_PORT>): "OK:<IP_DO_DISPOSITIVO>:<CMD_UDP_PORT>\n"
// 3) Telemetria: ">var:timestamp_ms:valor|g\n" para (<IP_LOCAL>,<UDP_PORT>)
//    Log: ">:timestamp_ms:Mensagem\n"

class WSerial_c {
protected:
  // UDP único (escuta e envia)
  AsyncUDP  _udp;                 // um socket só
  bool      _udpAvailable = false; // listener CMD ativo
  bool      _udpLinked    = false; // CONNECT recebido
  uint16_t  _cmdUdpPort   = 47268; // porta de comando

  IPAddress _remoteIP;            // destino (VSCode/LasecPlot)
  uint16_t  _remoteDataPort = 0;  // porta de dados destino (UDP_PORT)

  std::function<void(std::string)> on_input;

  void start(unsigned long baudrate = BAUD_RATE, uint16_t cmdUdpPort = 47268);
  void update();
  void _handleConnectPacket(const String& msg, const IPAddress& senderIP, uint16_t senderPort);
  void _udpSendLine(const String& line);
  static bool _parseHostPort(const String& s, String& host, uint16_t& port);

public:
  void stop();
  friend inline void startWSerial(WSerial_c *ws, unsigned long baudrate = BAUD_RATE, uint16_t cmdUdpPort = 47268) { ws->start(baudrate, cmdUdpPort); }
  friend inline void updateWSerial(WSerial_c *ws) { ws->update(); }

  template <typename T> void print(const T &data);
  template <typename T> void println(const T &data);
  void println();

  template <typename T> void plot(const char *varName, TickType_t x, T y, const char *unit = nullptr);
  template <typename T> void plot(const char *varName, T y, const char *unit = nullptr);

  void log(const char* text, uint32_t ts_ms = 0);
  void onInputReceived(std::function<void(std::string)> callback) { on_input = callback; }

  bool udpAvailable() const { return _udpAvailable; }
  bool udpLinked()    const { return _udpLinked; }
  uint16_t cmdUdpPort() const { return _cmdUdpPort; }
};

// -------- impl --------

void WSerial_c::stop() {
  if (_udpAvailable) _udp.close();
  _udpAvailable = false;
  _udpLinked = false;
  _remoteDataPort = 0;
}

void WSerial_c::start(unsigned long baudrate, uint16_t cmdUdpPort) {
  Serial.begin(baudrate);
  while (!Serial) { delay(1); } // USB CDC

  _cmdUdpPort   = cmdUdpPort;
  _udpAvailable = false;
  _udpLinked    = false;
  _remoteDataPort = 0;

  if (WiFi.isConnected() && _udp.listen(_cmdUdpPort)) {
    _udpAvailable = true;
    Serial.printf("[UDP] Listening CMD on %u\n", _cmdUdpPort);

    // Um único handler para CONNECT e para comandos UDP -> on_input
    _udp.onPacket([this](AsyncUDPPacket packet){
      String s; s.reserve(packet.length()+1);
      for (size_t i=0;i<packet.length();++i) s += char(packet.data()[i]);
      s.trim();

      // CONNECT
      if (s.startsWith("CONNECT:")) {
        _handleConnectPacket(s, packet.remoteIP(), packet.remotePort());
        return;
      }

      // Outros comandos UDP: repassa para on_input (se tiver)
      if (on_input) on_input(std::string(s.c_str()));
    });
  } else {
    Serial.println("[UDP] WiFi not connected or listen() failed. Using Serial only.");
  }
}

void WSerial_c::update() {
  // Entrada por Serial (callback on_input)
  if (Serial.available()) {
    if (on_input) on_input(std::string((Serial.readStringUntil('\n')).c_str()));
  }
}

void WSerial_c::_handleConnectPacket(const String& msg, const IPAddress& /*senderIP*/, uint16_t /*senderPort*/) {
  // msg = "CONNECT:<IP_LOCAL>:<UDP_PORT>"
  String spec = msg.substring(8); // após "CONNECT:"
  spec.trim();

  String host; uint16_t port = 0;
  if (!_parseHostPort(spec, host, port)) {
    Serial.printf("[UDP] Invalid CONNECT payload: %s\n", msg.c_str());
    return;
  }

  IPAddress clientIP;
  if (!clientIP.fromString(host)) {
    WiFi.hostByName(host.c_str(), clientIP); // resolve DNS
  }
  if (!clientIP) {
    Serial.printf("[UDP] Could not resolve client host: %s\n", host.c_str());
    return;
  }

  // Salva destino de dados
  _remoteIP = clientIP;
  _remoteDataPort = port;
  _udpLinked = true;

  // Responde OK:<MY_IP>:<CMD_UDP_PORT>\n para o par de dados
  IPAddress myIP = WiFi.localIP();
  char myIPStr[16]; snprintf(myIPStr, sizeof(myIPStr), "%u.%u.%u.%u", myIP[0],myIP[1],myIP[2],myIP[3]);
  String ok = "OK:"; ok += myIPStr; ok += ":"; ok += String(_cmdUdpPort); ok += "\n";
  _udpSendLine(ok);

  Serial.printf("[UDP] Linked to %s:%u (OK sent)\n", _remoteIP.toString().c_str(), _remoteDataPort);
}

void WSerial_c::_udpSendLine(const String& line) {
  if (!_udpLinked || !_udpAvailable || !_remoteIP || _remoteDataPort == 0) return;
  _udp.writeTo((const uint8_t*)line.c_str(), line.length(), _remoteIP, _remoteDataPort);
}

bool WSerial_c::_parseHostPort(const String& s, String& host, uint16_t& port) {
  int colon = s.lastIndexOf(':');
  if (colon <= 0) return false;
  host = s.substring(0, colon);
  String p = s.substring(colon+1);
  p.trim();
  long v = p.toInt();
  if (v <= 0 || v > 65535) return false;
  port = (uint16_t)v;
  return true;
}

// === API pública ===

template <typename T>
void WSerial_c::plot(const char *varName, T y, const char *unit) {
  plot(varName, (TickType_t) xTaskGetTickCount(), y, unit);
}

template <typename T>
void WSerial_c::plot(const char *varName, TickType_t x, T y, const char *unit) {
  // >var:timestamp_ms:valor[§unit]|g\n
  String str(">");
  str += varName; str += ":";
  uint32_t ts_ms = (uint32_t)(x);
  if (ts_ms < 100000) ts_ms = millis();
  str += String(ts_ms); str += ":"; str += String(y);
  if (unit && unit[0]) { str += "§"; str += unit; }
  str += "|g" NEWLINE;

  if (_udpAvailable && _udpLinked) _udpSendLine(str);
  else Serial.print(str);
}

template <typename T>
void WSerial_c::print(const T &data) {
  if (_udpAvailable && _udpLinked) {
    String s = String(data);
    if (!s.endsWith(NEWLINE)) s += NEWLINE;
    _udpSendLine(s);
  } else {
    Serial.print(data);
  }
}

template <typename T>
void WSerial_c::println(const T &data) {
  String s = String(data); s += NEWLINE;
  print(s);
}

void WSerial_c::println() {
  if (_udpAvailable && _udpLinked) _udpSendLine(String(NEWLINE));
  else Serial.println();
}

void WSerial_c::log(const char* text) {
  if (ts_ms == 0) ts_ms = millis();
  String line = String(text); line += "\n";
  if (_udpAvailable && _udpLinked) _udpSendLine(line);
  else Serial.print(line);
}

#endif
