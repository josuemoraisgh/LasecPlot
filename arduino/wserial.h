#pragma once
// wserial.h — UDP (AsyncUDP) header-only, with CONNECT/DISCONNECT
// Usage: wserial::beginUDP(47268);  wserial::loopUDP();  wserial::sendLineTo("msg\n");
#include <Arduino.h>
#include <WiFi.h>
#include <AsyncUDP.h>

#define BAUD_RATE 115200
#define NEWLINE "\r\n"

namespace wserial {
  namespace detail {

    /**
     * @brief IP address of the currently linked LasecPlot client.
     */
    IPAddress lasecPlotIP;

    /**
     * @brief Remote receive port configured by the LasecPlot client.
     */
    uint16_t  lasecPlotReceivePort = 0;

    /**
     * @brief Local port where the UDP server listens for packets.
     */
    uint16_t listenPort = 0;

    /**
     * @brief Indicates whether the UDP listener is successfully initialized.
     */
    bool isUdpAvailable = false;

    /**
     * @brief Indicates whether there is an active UDP link (CONNECT received).
     */
    bool isUdpLinked = false;

    /**
     * @brief Base timestamp (milliseconds) used for time series generation.
     */
    uint32_t base_ms = 0;

    /**
     * @brief Global AsyncUDP instance for managing UDP communication.
     */
    AsyncUDP udp;

    /**
     * @brief Callback function executed when data is received via UDP or Serial.
     */
    std::function<void(std::string)> on_input;

    /**
     * @brief Sends a line of text via UDP or Serial depending on link state.
     * @tparam T Data type (e.g., String, const char*, std::string).
     * @param txt Text to be sent.
     */
    template <typename T>
    void sendLine(const T &txt) {
      if(isUdpLinked) {
        String line = String(txt);
        udp.writeTo(reinterpret_cast<const uint8_t*>(line.c_str()), line.length(), lasecPlotIP, lasecPlotReceivePort);
      }
      else Serial.print(txt);
    }

    /**
     * @brief Parses a string in the format CMD:HOST:PORT into its components.
     * @param s Input string (full received command).
     * @param cmd Reference to store the command (e.g., CONNECT, DISCONNECT).
     * @param host Reference to store the hostname or IP address.
     * @param port Reference to store the numeric port.
     * @return true if successfully parsed, false otherwise.
     */
    bool parseHostPort(const String &s,String &cmd, String &host, uint16_t &port) {
      int c1 = s.indexOf(':');      // first ':'
      int c2 = s.lastIndexOf(':');  // last ':'

      if (c1 <= 0 || c2 <= c1) return false;

      cmd  = s.substring(0, c1);
      host = s.substring(c1 + 1, c2);

      long v = s.substring(c2 + 1).toInt();
      if (v <= 0 || v > 65535) return false;
      port = (uint16_t)v;
      return true;
    }

    /**
     * @brief Handles incoming UDP packets.
     * 
     * This callback processes CONNECT and DISCONNECT commands and updates
     * the link status with the LasecPlot client. If the packet does not match
     * the expected format, it forwards the raw message to the user callback.
     * 
     * @param packet The received UDP packet.
     */
    void handleOnPacket(AsyncUDPPacket packet) {
      String s((const char*)packet.data(), packet.length());
      s.trim();
      
      String cmd, host;
      uint16_t port;

      if(!parseHostPort(s,cmd,host,port)) { 
        on_input(std::string(s.c_str()));
        return;
      }

      // Resolve LasecPlot IP
      IPAddress ip;
      if (!ip.fromString(host)) {
        if (WiFi.hostByName(host.c_str(), ip) != 1) {
          Serial.printf("[UDP] DNS fail: %s\n", host.c_str());
          return;
        }
      } 
      if (ip == IPAddress()) { Serial.println("[UDP] Invalid IP"); return; }

      lasecPlotIP = ip;
      lasecPlotReceivePort = port;   // Store remote receive port

      if (cmd == "CONNECT") { // s = "CONNECT:<LASECPLOT_IP>:<LASECPLOT_RECEIVE_PORT>"
        isUdpLinked = true;
        const String txt = "CONNECT:" + WiFi.localIP().toString() + ":" + String(lasecPlotReceivePort) + "\n";
        sendLine(txt);
        Serial.printf("[UDP] Linked to %s:%u (OK sent)\n", lasecPlotIP.toString().c_str(), lasecPlotReceivePort);
        return;
      } else {
        if (cmd == "DISCONNECT"){ // Send DISCONNECT:<LASECPLOT_IP>:<LASECPLOT_RECEIVE_PORT> to target if linked
          if (isUdpLinked) {
            const String txt = "DISCONNECT:" + WiFi.localIP().toString() + ":" + String(lasecPlotReceivePort) + "\n";
            sendLine(txt);
            Serial.printf("[UDP] Linked to %s:%u (BYE sent)\n", lasecPlotIP.toString().c_str(), lasecPlotReceivePort);
            isUdpLinked = false;
            return;
          }
        }
      }
    }
  }
  
  /**
   * @brief Initializes Serial communication and the UDP listener.
   * @param baudrate Serial baud rate (default: 115200).
   * @param port UDP listening port (default: 47268).
   */
  void setup(unsigned long baudrate = BAUD_RATE, uint16_t port=47268) {
    using namespace detail;
    Serial.begin(baudrate);
    while (!Serial)
      delay(1);

    listenPort = port;
    // Try to start listening until it succeeds
    if (udp.listen(listenPort)) {
      isUdpAvailable = true;
      udp.onPacket(handleOnPacket);
      Serial.println("[UDP] Listening on " + String(listenPort));
    } else {
      isUdpAvailable = false;
      Serial.println("[UDP] listen() failed");
    }
  }

  /**
   * @brief Main loop for managing UDP/Serial input and reconnection attempts.
   * 
   * Retries UDP listening periodically if the setup failed, and forwards
   * incoming Serial data to the user-defined input callback.
   */
  void loop() {
    using namespace detail;
    // Retry listen periodically if setup failed
    static uint32_t lastRetry = 0;
    if (!isUdpAvailable && (millis() - lastRetry > 2000)) {
      lastRetry = millis();
      if (udp.listen(listenPort)) {
        isUdpAvailable = true;
        udp.onPacket(handleOnPacket);
        Serial.println("[UDP] Listening on " + String(listenPort) + " (retry ok)");
      }
    }
    if(Serial.available()){
      String linha = Serial.readStringUntil('\n'); // Read until '\n'
      on_input(linha.c_str());
    }
  }

  /**
   * @brief Sets the callback to handle incoming lines from Serial or UDP.
   * @param callback Function to be called with received text.
   */
  void onInputReceived(std::function<void(std::string)> callback) { detail::on_input = callback; }

  // === Public API ===

  /**
   * @brief Sends a single value for plotting with a specific timestamp.
   * @tparam T Numeric type of the value.
   * @param varName Variable name.
   * @param x Timestamp in ticks or milliseconds.
   * @param y Variable value.
   * @param unit Optional unit string (e.g., "°C").
   */
  template <typename T>
  void plot(const char *varName, TickType_t x, T y, const char *unit= nullptr)  {
    // >var:timestamp_ms:value[§unit]|g\n
    String str(">");
    str += varName;
    str += ":";
    uint32_t ts_ms = (uint32_t)(x);
    if (ts_ms < 100000)
      ts_ms = millis();
    str += String(ts_ms);
    str += ":";
    str += String(y);
    if (unit && unit[0])
    {
      str += "§";
      str += unit;
    }
    str += "|g" NEWLINE;

    detail::sendLine(str);
  }

  /**
   * @brief Sends a single value using the current system tick as timestamp.
   * @tparam T Numeric type of the value.
   * @param varName Variable name.
   * @param y Variable value.
   * @param unit Optional unit string.
   */
  template <typename T>
  void plot(const char *varName, T y, const char *unit= nullptr)  {
    plot(varName, (TickType_t) xTaskGetTickCount(), y, unit);
  }

  /**
   * @brief Sends an array of values for plotting with uniform time intervals.
   * @tparam T Numeric type of the array values.
   * @param varName Variable name.
   * @param dt_ms Time step between samples (milliseconds).
   * @param y Pointer to the array of values.
   * @param ylen Number of samples in the array.
   * @param unit Optional unit string.
   */
  template<typename T>
  void plot(const char *varName, uint32_t dt_ms, const T* y, size_t ylen, const char *unit)  {
    String str(">");
    str += varName;
    str += ":";

    for (size_t i = 0; i < ylen; i++)
    {
      str += String((uint32_t) detail::base_ms);  // keep as decimal with no spaces
      str += ":";
      str += String((double)y[i], 6);      // 6 decimal places
      detail::base_ms += dt_ms; 
      if (i < ylen - 1) str += ";";
    }

    if (unit != nullptr) {
      str += "§";
      str += unit;
    }

    str += "|g" NEWLINE;
    detail::sendLine(str);
  }

  /**
   * @brief Sends a log message with timestamp.
   * @param text Text message to send.
   * @param ts_ms Timestamp in milliseconds (0 to use current time).
   */
  void log(const char *text, uint32_t ts_ms)  {
    if (ts_ms == 0)
      ts_ms = millis();
    String line = String(ts_ms);
    line += ":";
    line += String(text ? text : "");
    line += NEWLINE;
    detail::sendLine(line);
  }
  
  /**
   * @brief Sends data followed by a newline.
   * @tparam T Data type.
   * @param data Data to send.
   */
  template <typename T>
  inline void println(const T &data)  {
    detail::sendLine(String(data) + NEWLINE);
  }

  /**
   * @brief Sends data without appending a newline.
   * @tparam T Data type.
   * @param data Data to send.
   */
  template <typename T>
  inline void print(const T &data)  {
    detail::sendLine(data);
  }
  
  /**
   * @brief Sends a newline only.
   */
  inline void println()  {
    detail::sendLine(NEWLINE);
  }
}
