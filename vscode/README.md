# LasecPlot — Guia de Uso

> **LasecPlot** é um *fork* do Teleplot focado em:
> - **Conexões configuráveis** (UDP e Serial) direto no VS Code/webview  
> - **Parser tolerante** (aceita formato “Teleplot” e variações “serial-like” com `>`)  
> - **Handshake simples** para **vincular/desvincular** um emissor UDP (firmware/PC)

Este README explica:
1) a interface (o que cada botão faz),  
2) como **abrir/fechar** (Open/Close) conexões **Serial** e **UDP**,  
3) como usar o **wserial** no Arduino/ESP32,  
4) como usar o **server_upd_test.py** em Python,  
5) formatos de telemetria e recursos do visor.

---

## 1) Instalação e Abertura

- **VS Code (extensão .vsix)**
  1. `npm ci && npm run compile`
  2. `npx @vscode/vsce package` → gera `.vsix`
  3. VS Code → **Ctrl+Shift+P → Extensions: Install from VSIX…**
  4. **Ctrl+Shift+P → LasecPlot: Start** (ou clique no ícone “graph-line” na Status Bar)

- **Navegador como webview estático**  
  Abra o `index.html` empacotado em `media/` (a extensão já faz isso no painel).

---

## 2) Tour da Interface (baseado no `index.html`)

Topo do painel:

- **UDP-Receive:** mostra seu **IP local** e a **porta de dados UDP** (ex.: `UDP-Receive: 192.168.0.20:47269`).
- **Conexões**:
  - **Serial**: lista portas, escolha o **baud** e clique **Open** para abrir / **Close** para fechar.
  - **UDP** (remoto para comandos):  
    - Campo `host:porta` (ex.: `192.168.0.50:47268`) → **Open** para vincular, **Close** para desconectar.  
    - Quando vinculado, aparece `UDP-Send: <remoteAddress>:<cmdUdpPort>`.
- **Play/Pause**, **janela de tempo** (1s…1h, etc.), **Export** (layout, sessão JSON, CSV), **Clear**, **dark/light**.
- **Painel esquerdo (variáveis)**: filtro, arrastar variáveis para criar gráficos/último valor.
- **Widgets**: gráfico, “single value”, 3D. Cada widget tem fechar (╳), recalcular estatísticas (‱) e redimensionar (⇲).
- **Painel direito (comandos/logs)**: botões de comando, console de log, e **barra de envio** (tanto para Serial quanto UDP) com seleção de final de linha (`\r\n`, `\n`, `\r`, vazio).

---

## 3) Conexões: **Open** / **Close** (Serial e UDP)

### 3.1 Serial
- **Open**:
  - Selecione **Port** (COMx/tty…) e **Baud** (ex.: 115200).
  - Clique **Open**. O cabeçalho passa a mostrar a porta/baud conectados.
- **Close**:
  - Clique **Close** para fechar a porta serial.

**Envio de texto**: no painel direito, escolha o destino **Serial** (aparece como “Send to Serial COMx (… )”), digite, selecione o **endline** e clique **Send** (ou Enter).

### 3.2 UDP (remoto de comandos)
- **Open**:
  - Clique **Update**/**Open** e digite `host:porta` do **destino remoto de comandos** (ex.: `192.168.0.50:47268`).
  - Isso atualiza `remoteAddress` e `cmdUdpPort` e envia uma mensagem de **CONNECT** (via host VS Code) ao dispositivo/servidor.
  - Ao vincular, o cabeçalho mostra `UDP-Send: <host>:<porta>`.
- **Close**:
  - Clique **Close**. O host envia **DISCONNECT** ao destino remoto e limpa o estado local.

> **Roteamento no dispositivo (wserial):**
> - **Conectado (linked)** → tudo que o firmware mandar (print/println/plot/log) vai **via UDP**  
> - **Desconectado** → tudo vai **pela Serial**  
>   (é o “oposto” do connect: no connect sai da serial e passa a ir por UDP)

---

## 4) Telemetria — formatos aceitos

O LasecPlot aceita os formatos do Teleplot **e** variantes “serial-like” por conveniência:

### Formato Teleplot (oficial)
```
nome:valor
nome:timestamp_ms:valor
nome:valor§unidade
nome:timestamp_ms:valor§unidade|flags
```

**Ex. UDP**:
```bash
echo "temp:1700000123456:25.2§°C|g" | nc -u -w0 127.0.0.1 47269
```

### Variante “serial-like”
- Aceita `>` no lugar do primeiro `:`:
```
nome>valor|g
nome>timestamp_ms:valor§unidade|g
```

> **Flags** (`g`, `t`, `xy`, `np`, cores, múltiplos pontos separados por `;`, múltiplas linhas `\n`, etc.) seguem a referência Teleplot.

### Logs (texto)
- `>:timestamp_ms:mensagem\n` → aparece no painel de log.

---

## 5) Protocolo de **vincular**/**desvincular** via UDP (handshake simples)

Há duas peças possíveis do “outro lado” (o **alvo** do handshake): o **firmware/Arduino** (com `wserial`) e o **servidor de teste Python** (`server_upd_test.py`).  
Ambos fazem a mesma função: receber um **CONNECT** no **CMD_UDP_PORT** e passar a enviar os dados para o **UDP_PORT** do LasecPlot.

### 5.1 Firmware Arduino/ESP32 com **wserial**
- **Porta de comandos (CMD_UDP_PORT)** padrão: **47268**
- **Mensagens** (resumo prático):
  - **Host → Dispositivo (CMD_UDP_PORT)**  
    `CONNECT:<IP_LOCAL_DO_VSCODE>:<UDP_PORT_VSCODE>`
  - **Dispositivo → Host (para <IP_LOCAL_DO_VSCODE, UDP_PORT_VSCODE>)**  
    **ACK** de vínculo (implementação atual envia):  
    `CONNECT:<IP_DO_DISPOSITIVO>:<CMD_UDP_PORT>\n`
  - **Telemetria** (quando **vinculado**)  
    `>var:timestamp_ms:valor|g\n` e `>:timestamp_ms:Mensagem\n` (log)
  - **Desconexão**  
    - **Host → Dispositivo (CMD_UDP_PORT)**: `DISCONNECT` **ou** `DISCONNECT:<IP_LOCAL>:<UDP_PORT>`  
    - **Dispositivo → Host (para <IP_LOCAL, UDP_PORT>)**: `DISCONNECT:<IP_DO_DISPOSITIVO>:<CMD_UDP_PORT>\n`  
    - Dispositivo zera o link → **volta a enviar pela Serial**

> **Observação:** o comentário inicial do header cita “OK:…”, porém a implementação atual usa **`CONNECT:…`** como ACK. O LasecPlot não depende do texto do ACK para exibir; o ACK é útil para **debug/log** e confirmação de rota.

### 5.2 Servidor de teste em **Python**
- **Comando**: `python server_upd_test.py --cmd-port 47268 --freq 1.0 --rate 30 --amp 1.0 --var sin`
- **Handshake**:
  - **Cliente/Host → Servidor (cmd_port)**: `CONNECT:<CLIENT_LOCAL_IP>:<CLIENT_UDP_PORT>`
  - **Servidor → Cliente (<CLIENT_LOCAL_IP, CLIENT_UDP_PORT>)**: `CONNECTED:<SERVER_IP>:<CMD_PORT>`
  - **Seno (dados)**: `>sin:<ts_ms>:<valor>|g\n`
- **Desconexão**:
  - **Cliente/Host → Servidor (cmd_port)**: `DISCONNECT` **ou** `DISCONNECT:<ip>:<port>`
  - **Servidor → Cliente (<ip,port>)**: `DISCONNECT:<SERVER_IP>:<CMD_PORT>`
  - **Servidor** pausa os envios (_data_target = None)

> Nota: o prefixo de ACK (“CONNECTED:” vs “CONNECT:”) é diferente do firmware; ambos funcionam com o LasecPlot. O que importa é o **destino de dados** ser atualizado corretamente para o **UDP_PORT** exibido como **UDP-Receive** no topo do painel.

---

## 6) Como usar o **wserial** (Arduino/ESP32)

1. **Inclua** `wserial.h` no projeto (ESP32 + WiFi + AsyncUDP).  
2. **Chame** `startWSerial(&ws, BAUD_RATE, 47268)` após conectar no Wi-Fi.  
3. Em *loop*, chame `updateWSerial(&ws)` (para ler comandos de Serial/UDP).  
4. Envie telemetria com `ws.plot("var", valor)` ou `ws.log("mensagem")`.  
5. Para **desconectar** (voltar para Serial), chame `ws.disconnect()` ou envie `DISCONNECT` do host.

Exemplo mínimo:
```cpp
#include "wserial.h"
WSerial_c ws;

void setup() {
  WiFi.begin("SSID","PASS");
  while (WiFi.status() != WL_CONNECTED) delay(100);
  startWSerial(&ws, 115200, 47268);  // CMD_UDP_PORT
}

void loop() {
  static uint32_t t0 = millis();
  float y = sinf((millis() - t0) * 2.0f * 3.14159f * 1.0f / 1000.0f);
  ws.plot("sin", y, "u");            // envia via UDP se conectado; senão via Serial
  updateWSerial(&ws);
  delay(20);
}
```

**Conectar do LasecPlot**:
- Veja no topo **UDP-Receive: <IP_LOCAL>:<UDP_PORT>** (ex.: `192.168.0.20:47269`).
- Abra a seção **UDP** e **Open** para `<IP_DO_DISPOSITIVO>:47268` (CMD).
- O host envia `CONNECT:<IP_LOCAL>:<UDP_PORT>`. O firmware responde e começa a enviar dados.

**Desconectar**:
- Clique **Close** na seção UDP (o host envia **DISCONNECT**).
- O firmware responde `DISCONNECT:…` e volta a roteamento por **Serial**.

---

## 7) Como usar o **server_upd_test.py** (PC/Python)

1. `python server_upd_test.py --cmd-port 47268 --freq 1.0 --rate 30 --amp 1.0 --var sin`  
2. No LasecPlot, anote **UDP-Receive** (ex.: `192.168.0.20:47269`).
3. No painel **UDP**, **Open** para `127.0.0.1:47268` (ou o IP onde o script está).
4. O host envia `CONNECT:<IP_LOCAL>:<UDP_PORT>`, o servidor responde `CONNECTED:…` e começa a enviar `>sin:…|g`.

**Fechar**:
- **Close** → envia `DISCONNECT` → servidor responde e **pausa** a transmissão.

---

## 8) Exportar/Importar e Dicas

- **Save layout** (⛶) / **Import layout** (🗁): salva/restaura a disposição de widgets.
- **Export session**: JSON ou CSV (com escolha de separadores).
- **Clear**: limpa telemetria atual.
- **Dark/Light**: alterna tema.
- **Arrastar variáveis** do painel esquerdo para criar gráfico ou “last value”.
- **XY/3D/Estatísticas**: widgets especializados (headers mostram **Min/Max/Mean/Median/Stdev** quando solicitado).
- **Envio de texto**:
  - **Serial**: “Send to Serial COMx (…)”
  - **UDP**: “Send to UDP <host>:<port> (…)”
  - Selecione **endline** (`\r\n`, `\n`, `\r`, vazio).

---

## 9) Troubleshooting

- **Nada aparece**:
  - Confirme que há **dados chegando** na porta **UDP-Receive** mostrada no topo.
  - Use `nc -u`/`sock.sendto()` com um valor simples `foo:123|g` para testar.
- **Handshake não “fecha”**:
  - Verifique o **IP local** usado no `CONNECT`. Muitos SOs têm múltiplas interfaces — veja o IP exibido no topo do painel.
  - No firmware, confira o **CMD_UDP_PORT** (padrão `47268`) e se está “escutando”.
- **Logs aparecem mas gráfico não**:
  - Repare o **formato**: `>var:ts:valor|g` (ou `var:ts:valor|g`). Sem `|g` o dado pode não ir para série numérica.
- **Serial em vez de UDP**:
  - No firmware, se **desvinculado**, tudo volta para **Serial**. Faça **Open/CONNECT** de novo.

---

## 10) Resumo rápido (cola de bolso)

- **Open Serial**: escolha **porta/baud** → **Open** (envio/recebimento pela serial)  
- **Open UDP**: preencha `host:cmd_port` → **Open** (host manda `CONNECT:<IP_LOCAL>:<UDP_PORT>`)  
- **Transmitindo**:
  - **Conectado** → firmware envia via **UDP** (`>var:ts:val|g`)  
  - **Desconectado** → firmware envia via **Serial**  
- **Close**: **Serial** → fecha porta; **UDP** → envia `DISCONNECT` e limpa link  
- **Formatos**: `nome:valor` / `nome:ts:valor` / “serial-like” `nome>ts:valor|g`  
- **Export/Import**: layout, JSON, CSV; **Clear**; **dark/light**; **drag & drop** de variáveis

---

## Licença e Créditos

- Licença: MIT (mesma do Teleplot).  
- Projeto original: Teleplot — obrigado aos autores e comunidade.  
- Este fork adiciona portas configuráveis, parser tolerante e fluxo de conexão/desconexão simples.
