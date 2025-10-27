const getConfiguredUdpPort = () => (window._lasecplot_config && Number(window._lasecplot_config.udpPort)) || 47269;
class ConnectionLasecPlotVSCode extends Connection{
    constructor() {
        super();
        this.name="localhost-VSCode"
        this.type = "lasecplot-vscode";
        this.vscode = vscode;
        this.udp = new DataInputUDP(this, "UDP");
        this.udp.address = "localhost";
        this.udp.port = UDPport;
        this.inputs.push(this.udp);
        
        this.supportSerial = true;
        let serialIn = new DataInputSerial(this, "Serial");
        this.inputs.push(serialIn);
    }

    connect() {
        if(!this.vscode) return false;
        window.addEventListener('message', message => {
            let msg = message.data;
            if("id" in msg){
                for(let input of this.inputs){
                    if(input.id == msg.id){
                        input.onMessage(msg);
                        break;
                    }
                }
            }
            else{
                if("data" in msg) {
                    parseData(msg); //update server so it keeps track of connection IDs when forwarding data
                }
                else if("cmd" in msg) {
                    //nope
                }
            }
        });
        this.vscode.postMessage({ cmd: "listSerialPorts"});
        //Report UDP input as connected
        this.udp.connected = true;
        this.connected = true;
        return true;
    }

    disconnect() {
        for(let input of this.inputs){
            input.disconnect();
        }
        this.connected = false;
    }

    sendServerCommand(command) {
        this.vscode.postMessage(command);
    }

    sendCommand(command) {
        for(let input of this.inputs){
            input.sendCommand(command);
        }
    }

    updateCMDList() {
        for(let input of this.inputs){
            input.updateCMDList();
        }
    }

    createInput(type) {
        if(type=="serial") {
            let serialIn = new DataInputSerial(this, "Serial");
            this.inputs.push(serialIn);
        }
    }
}

// GPT_PATCH: listen for config from extension to update ports live
window.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'lasecplot-config') {
    window._lasecplot_config = { udpPort: msg.udpPort, cmdUdpPort: msg.cmdUdpPort };
    try {
      if (window.app && Array.isArray(app.connections)) {
        app.connections.forEach(conn => {
          if (conn && Array.isArray(conn.inputs)) {
            conn.inputs.forEach(inp => {
              if (inp && inp.type === 'UDP') {
                inp.port = Number(msg.udpPort);
              }
            });
          }
        });
      }
    } catch(e) {}
  }
});
