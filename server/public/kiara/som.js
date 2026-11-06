/* K.IA.RA: identidade do espaço e trilha sonora (compartilhado por monitor e música) */
/* Shared venue identity. Legacy storage key preserves existing monitor preferences. */
(function(){
 const key='aura-monitor';
 function read(){try{const v=JSON.parse(localStorage.getItem(key)||'{}');return v&&typeof v==='object'?v:{}}catch{return {}}}
 let transferred=null;
 if(location.protocol==='file:'&&location.hash.startsWith('#venue=')){try{transferred=JSON.parse(decodeURIComponent(location.hash.slice(7)));const value={...read(),...transferred};localStorage.setItem(key,JSON.stringify(value));}catch{} }
 function transparency(v){const n=Number(v.venueTransparency);return Number.isFinite(n)&&v.venueTransparency!=null?Math.max(0,Math.min(100,n)):65}
 function render(value){const v=value||transferred||read();document.documentElement.style.setProperty('--venue-opacity',String(1-transparency(v)/100));const name=typeof v.name==='string'?v.name.trim().slice(0,45):'';const description=typeof v.description==='string'?v.description.trim().slice(0,240):'';
 function put(id,text){const e=document.getElementById(id);if(e){e.textContent=text;e.hidden=!text}}
 put('salon',name);put('salon-description-display',description);put('venue-name',name);put('venue-description',description);
 for(const id of ['venue-card','venue-spotlight']){const card=document.getElementById(id);if(card){card.hidden=!(name||description);card.dataset.motion=v.venueMotion===false?'off':'on'}}
 document.querySelectorAll('[data-venue-name]').forEach(e=>e.textContent=name||'K.IA.RA Beauty Studio');
 if(location.protocol==='file:')document.querySelectorAll('a[href^="portal.html"]').forEach(e=>e.href='portal.html#venue='+encodeURIComponent(JSON.stringify({name,description,venueMotion:v.venueMotion!==false,venueTransparency:transparency(v)})));
 }
 window.KiaraVenue={read,render,transparency};
 window.addEventListener('storage',e=>{if(e.key===key)render()});window.addEventListener('pageshow',()=>render());
})();
/* Original KIARA music: four styles, three synchronized scene variations. */
class KiaraSoundtrack {
 constructor(onChange,onError){Object.assign(this,{onChange,onError,enabled:false,loading:false,ready:false,ctx:null,gains:[],sources:[],volume:.3,scene:0,hold:false,fadeTimer:null,style:'calma',loadedStyle:null,loadId:0,banks:new Set()});this.styles={calma:'Calma',discoteca:'Discoteca',romantica:'Romântica',cosmica:'Cósmica'};this.titles=['Sua essência','Seu universo','Seu momento'];}
 init(){if(this.ctx)return;const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw Error('Áudio indisponível');this.ctx=new AC();this.master=this.ctx.createGain();this.master.gain.value=0;const limiter=this.ctx.createDynamicsCompressor();limiter.threshold.value=-12;limiter.ratio.value=4;this.master.connect(limiter);limiter.connect(this.ctx.destination)}
 async toggle(){this.enabled=!this.enabled;if(!this.enabled){this.sync();return}try{this.init();await this.ctx.resume();if(!this.ready||this.loadedStyle!==this.style)await this.loadStyle();else this.sync()}catch{this.enabled=false;this.loading=false;this.onChange();this.onError('Não foi possível iniciar a música. Tente novamente.')}}
 async setStyle(style){if(!this.styles[style]||style===this.style)return;this.style=style;this.onChange();if(this.ctx&&this.enabled)await this.loadStyle();}
 async loadStyle(){const id=++this.loadId,style=this.style;this.loading=true;this.onChange();try{const buffers=await Promise.all(['essencia','universo','momento'].map(async name=>{const r=await fetch('/kiara/trilhas/'+style+'-'+name+'.mp3');if(!r.ok)throw Error('Trilha indisponível');return this.ctx.decodeAudioData(await r.arrayBuffer())}));if(id!==this.loadId)return;const old=this.bank;const bank={sources:[],gains:[],retired:false};this.banks.add(bank);const start=this.ctx.currentTime+.05;buffers.forEach((buffer,i)=>{const source=this.ctx.createBufferSource();source.buffer=buffer;source.loop=true;const gain=this.ctx.createGain();gain.gain.value=0;source.connect(gain);gain.connect(this.master);source.start(start);bank.sources.push(source);bank.gains.push(gain)});this.bank=bank;this.sources=bank.sources;this.gains=bank.gains;this.ready=true;this.loadedStyle=style;this.loading=false;this.sync();if(old){old.retired=true;old.gains.forEach(g=>this.ramp(g.gain,0,3));setTimeout(()=>{old.sources.forEach(s=>{try{s.stop();s.disconnect()}catch{}});old.gains.forEach(g=>g.disconnect());this.banks.delete(old)},3300)}}catch{if(id!==this.loadId)return;this.loading=false;if(this.ready)this.style=this.loadedStyle;else this.enabled=false;this.onChange();this.onError('Não foi possível carregar este estilo. Tente novamente.')}}
 ramp(param,value,seconds){const t=this.ctx.currentTime;if(param.cancelAndHoldAtTime)param.cancelAndHoldAtTime(t);else{const v=param.value;param.cancelScheduledValues(t);param.setValueAtTime(v,t)}param.linearRampToValueAtTime(value,t+seconds)}
 sync(scene=this.scene,hold=this.hold){this.scene=scene;this.hold=hold;clearTimeout(this.fadeTimer);if(!this.ready){this.onChange();return}const play=this.enabled&&!this.hold;this.gains.forEach((gain,i)=>this.ramp(gain.gain,i===scene?1:0,3));this.ramp(this.master.gain,play?this.volume:0,.7);if(play)this.ctx.resume().then(()=>this.onChange()).catch(()=>this.onError('Clique em Música para retomar o áudio.'));else this.fadeTimer=setTimeout(()=>{if(!this.enabled||this.hold)this.ctx.suspend().then(()=>this.onChange()).catch(()=>{})},800);this.onChange()}
 setVolume(value){this.volume=Math.max(0,Math.min(1,Number(value)||0));if(this.ready)this.ramp(this.master.gain,this.enabled&&!this.hold?this.volume:0,.15);this.onChange()}
}
window.KiaraSoundtrack=KiaraSoundtrack;
