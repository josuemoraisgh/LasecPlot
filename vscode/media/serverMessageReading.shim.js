// Shim opcional: se o seu projeto já tiver `media/classes/communication/serverMessageReading.js`
// você pode remover este arquivo. Aqui apenas expomos uma API previsível
// para que a extensão possa encaminhar as linhas recebidas por UDP.
(function(){
  if(!window.ServerMessageReading){
    window.ServerMessageReading = {
      parse: function(line){
        // Por padrão, não faz nada além de gerar um evento.
        const ev = new CustomEvent('teleplot:udpLine', { detail: { line } });
        window.dispatchEvent(ev);
      }
    };
  }
})();