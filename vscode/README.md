
# LasecPlot – Teleplot UDP

Extensão VS Code que:
- Abre um **listener UDP** na porta configurada (`lasecplot.udpPort`, padrão **47269**).
- Envia comandos UDP para o IP/porta de comando (`lasecplot.cmdUdpPort`, padrão **47268**).
- Painel lateral com campo de **IP** e botão **Connect**. Ao conectar envia `CONNECT <clientId>\n` (UTF-8).
- **Status Bar** mostra o destino atual ou "Not connected".
- Campo de comando com botão **Send**: envia texto puro (UTF-8, sufixo `\n`).  
- As mensagens recebidas **do IP alvo e da porta `udpPort`** são mostradas no log do painel.

## Configurações
- `lasecplot.udpPort` (listener – dados) – padrão 47269  
- `lasecplot.cmdUdpPort` (envio – comando) – padrão 47268

Se o usuário digitar `IP:porta` no campo, a **porta de comando** será a informada. Caso não informe a porta, será usada `lasecplot.cmdUdpPort`.

## Observações
- O último IP/porta usados ficam salvos e são reabertos no próximo uso.
- Não há *timeout* automático; o listener permanece ativo até fechar o VS Code ou mudar configurações.
