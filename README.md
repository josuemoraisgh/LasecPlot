
# LasecPlot (fork do Teleplot)

> **LasecPlot** é um *fork* do [Teleplot](https://github.com/nesnes/teleplot) com focos principais em:
> 1) **Portas UDP configuráveis** pela própria extensão do VS Code;  
> 2) **Compatibilidade ampliada** do parser UDP (aceita também a sintaxe “serial-like” com `>`);  
> 3) **Empacotamento VSIX** com *assets* (pasta `media/`) e *workflow* de release.

A base conceitual de formato de telemetria, comandos e 3D vem do Teleplot original.

---

## Principais diferenças deste fork

### 1) Portas UDP configuráveis (VS Code)
Na extensão do VS Code:
- **`teleplot.udpPort`** (padrão **47269**) – porta de telemetria (entrada de dados).
- **`teleplot.cmdUdpPort`** (padrão **47268**) – porta de comandos (*ex-RPC*).

Altere em **Settings → Extensions → LasecPlot** ou no `settings.json`:
```json
{
  "teleplot.udpPort": 50000,
  "teleplot.cmdUdpPort": 50001
}
```
> A extensão reinicia o socket ao detectar mudança, aplicando a nova porta em tempo real.

### 2) Parser UDP mais tolerante
Além do formato oficial (`nome:timestamp:valor§unidade|flags`), o LasecPlot aceita a variante “serial-like” **via UDP**, por comodidade:
- **`nome>timestamp_ms:valor§unidade|g`** → tratado como `nome:timestamp_ms:valor§unidade|g`
- **`nome>valor|g`**           → tratado como `nome:valor|g`

Isso facilita portar código que já escrevia `>` (pensando em serial) sem precisar reescrever o emissor para UDP.

### 3) VSIX inclui a pasta `media/`
O pacote da extensão inclui `media/**` e `images/**` para o webview funcionar *out-of-the-box*.

---

## Como instalar a extensão (VSIX)

1. Gere o pacote:  
   ```bash
   npm ci
   npm run compile
   npx @vscode/vsce package
   ```
   Isso criará um arquivo `publisher.name-version.vsix`.

2. No VS Code: **Ctrl+Shift+P → Extensions: Install from VSIX…**  
   Selecione o `.vsix` gerado.

3. Abra o painel do LasecPlot:  
   **Ctrl+Shift+P → LasecPlot: Start** (ou clique no ícone “graph-line” na Status Bar).

---

## Enviando telemetria (UDP)

### Formato principal (compatível com Teleplot)
```
nome:valor
nome:timestamp_ms:valor
nome:valor§unidade
nome:timestamp_ms:valor§unidade|flags
```

Exemplo rápido (Linux/macOS):
```bash
echo "myValue:1234|g" | nc -u -w0 127.0.0.1 47269
```

### Variante “serial-like” aceita por este fork (via UDP)
```
nome>valor|g
nome>timestamp_ms:valor§unidade|g
```

> A documentação detalhada de flags (`g`, `t`, `xy`, `np`, `clr`, múltiplos pontos com `;`, múltiplas linhas com `\n`, etc.) segue a referência do Teleplot original.

---

## Exemplo em Python (seno contínuo)

```python
import socket, time, math

HOST = "127.0.0.1"
PORT = 47269  # ou a porta configurada em Settings
addr = (HOST, PORT)
sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

t0 = time.time()
while True:
    ts_ms = int(time.time() * 1000)
    val = math.sin((time.time() - t0) * 2.0 * math.pi * 1.0)  # 1 Hz
    msg = f"sin:{ts_ms}:{val}|g"
    sock.sendto(msg.encode("utf-8"), addr)
    time.sleep(0.02)  # ~50 msg/s
```

Se preferir a sintaxe “serial-like”:
```python
msg = f"sin>{ts_ms}:{val}|g"   # este fork converte '>' para ':'
sock.sendto(msg.encode("utf-8"), addr)
```

---

## Comandos (RPC simples) por UDP

Envie `|cmd|param|` para a porta de comandos (padrão **47268**):
```bash
echo "|sayHello|world|" | nc -u -w0 127.0.0.1 47268
```

---

## Execução do servidor (opcional)

Este repositório mantém as instruções originais para executar o servidor Teleplot (Node, Docker, binário).  
Para uso apenas como **extensão VS Code**, basta instalar o VSIX e enviar UDP para a porta configurada.  
Para uso em **navegador**/**servidor**, siga as seções do README original (Node/Docker/etc.).

---

## Licença e créditos

- **Licença:** MIT (mesma do projeto original).  
- **Projeto original:** [Teleplot](https://github.com/nesnes/teleplot) — agradecimentos aos autores e à comunidade.  
- **Este fork:** adiciona portas configuráveis e parser UDP mais tolerante, preservando compatibilidade e formato oficial.

---

### Notas de compatibilidade
- Se você mudar **publisher**/**name** no `package.json`, o VS Code tratará como **outra extensão** (IDs diferentes).  
- Se estiver migrando de Teleplot para LasecPlot, considere publicar uma última versão “ponte” na extensão antiga avisando do novo ID.
