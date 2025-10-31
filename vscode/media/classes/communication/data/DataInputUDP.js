class DataInputUDP extends DataInput{
    constructor(_connection, _name) {
        super(_connection, _name);
        this.type = "UDP";
        this.address = "";
        this.port = UDPport;

        // novos campos para habilitar a barra de envio
        this.textToSend = "";
        this.endlineToSend = "";
    }

    connect(){
        // Para UDP você já está “conectado” logicamente ao abrir a view,
        // então normalmente não precisa fazer nada aqui.
        // Mas se no seu fluxo você só quer mostrar como conectado:
        this.connected = true;
    }

    disconnect(){
        // UDP é sem estado fixo, então normalmente nada aqui.
        this.connected = false;
    }

    onMessage(msg){
        if("data" in msg) {
            msg.input = this;
            parseData(msg);
        }
        else if("cmd" in msg) {
            //nope
        }
    }

    sendCommand(command){
        // isso já existia: manda comandos tipo "|_telecmd_list_cmd|"
        this.connection.sendServerCommand({ id: this.id, cmd: command});
    }

    updateCMDList(){
        this.sendCommand("|_telecmd_list_cmd|");
    }

    // NOVO: usado pelo botão Send da barra
    // funcionamento é análogo ao DataInputSerial.sendText,
    // mas em vez de cmd:"sendToSerial", vamos mandar {data: ...}
    // porque a extensão já trata qualquer message.data e envia via UDP.
    sendText(text, lineEndings) {
        let escape = lineEndings.replace("\\n","\n");
        escape = escape.replace("\\r","\r");

        // para UDP, mandamos direto como message.data
        // (isso cai no if ("data" in message) do extension.ts)
        this.connection.sendServerCommand({
            data: text + escape
        });
    }
}