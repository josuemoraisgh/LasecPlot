(function(){
  if(!window.ServerMessageReading){
    window.ServerMessageReading = { parse: function(line){
      const ev = new CustomEvent('teleplot:udpLine', { detail: { line } });
      window.dispatchEvent(ev);
    }};
  }
})();