// Real browser fixture reproducing the nested composer picker and an effort
// control which overlaps the centre of a model row, as seen in failure logs.
export const PICKER_PAGE = `<!doctype html><meta charset="utf-8">
<style>
  #prompt-textarea {position:absolute;left:100px;top:400px;width:500px;min-height:45px}
  #effort {position:absolute;left:650px;top:410px;width:110px;height:35px}
  #effort-menu {position:absolute;left:550px;top:465px;width:230px;height:100px;background:white;z-index:10}
  #model-trigger {position:absolute;left:60px;top:0;width:150px;height:35px;z-index:40}
  #models {position:absolute;left:550px;top:465px;width:230px;background:white;z-index:20}
  #models [role=menuitemradio] {height:42px;box-sizing:border-box;padding:10px 12px;cursor:pointer}
  #slider {position:absolute;left:10px;top:55px;width:200px}
  #send {position:absolute;left:800px;top:410px}
</style>
<div id="prompt-textarea" contenteditable="true"></div>
<button id="effort" aria-label="Choose model and thinking effort" aria-haspopup="menu" aria-expanded="false">Medium</button>
<div id="effort-menu" role="menu" hidden><button id="model-trigger">Medium ›</button><input id="slider" type="range" min="0" max="2" step="1" value="1" aria-valuetext="Medium"></div>
<div id="models" role="menu" hidden></div><button id="send" data-testid="send-button">Send</button>
<div id="messages"></div><div id="apps" hidden><button role="option"><span>chatgpt-coder</span></button></div>
<script>
  const effort = document.querySelector('#effort'), menu = document.querySelector('#effort-menu'), models = document.querySelector('#models');
  const trigger = document.querySelector('#model-trigger'), slider = document.querySelector('#slider'), editor = document.querySelector('#prompt-textarea');
  window.model = 'GPT-5.6 Sol'; window.wrongHits = 0; window.sends = 0;
  function renderModels() {
    models.innerHTML = ['GPT-6','GPT-5.6 Sol'].map(name => '<div role="menuitemradio" tabindex="-1" aria-checked="'+(window.model === name)+'" data-model-selected="'+(window.model === name)+'"><span>'+name+'</span></div>').join('');
    models.querySelectorAll('[role=menuitemradio]').forEach(row => row.onclick = () => { window.model = row.textContent; models.hidden = true; renderModels(); });
  }
  renderModels();
  effort.onclick = () => { menu.hidden = !menu.hidden; models.hidden = true; effort.setAttribute('aria-expanded',String(!menu.hidden)); };
  trigger.onclick = () => { if (!models.hidden) { window.wrongHits++; } models.hidden = !models.hidden; };
  slider.oninput = () => { const level = ['Low','Medium','High'][Number(slider.value)]; slider.setAttribute('aria-valuetext',level); effort.textContent = level; trigger.textContent = level+' ›'; };
  document.addEventListener('keydown',event => { if (event.key === 'Escape') { if (!models.hidden) models.hidden = true; else { menu.hidden = true; effort.setAttribute('aria-expanded','false'); } } });
  editor.addEventListener('input',() => { document.querySelector('#apps').hidden = !editor.textContent.startsWith('@'); });
  document.querySelector('#apps button').onclick = () => { editor.innerHTML = '<span data-id="plugin:chatgpt-coder" data-keyword="chatgpt-coder" contenteditable="false">chatgpt-coder</span>'; document.querySelector('#apps').hidden = true; const range=document.createRange(); range.selectNodeContents(editor); range.collapse(false); const sel=getSelection(); sel.removeAllRanges(); sel.addRange(range); };
  document.querySelector('#send').onclick = async () => {
    const prompt = editor.innerText; window.sends++; editor.innerText = '';
    const stop = document.createElement('button'); stop.dataset.testid='stop-button'; document.body.appendChild(stop);
    const message = document.createElement('div'); message.dataset.messageAuthorRole='assistant'; document.querySelector('#messages').appendChild(message);
    try { const answer = window.respond ? await window.respond(prompt, window.model, slider.getAttribute('aria-valuetext')) : 'Prepared the requested model and effort.'; message.innerHTML = '<div class="markdown"></div>'; message.firstChild.textContent = answer; }
    catch (error) { message.innerHTML = '<div class="markdown"></div>'; message.firstChild.textContent = 'Fixture error: '+error.message; window.fixtureError = error.message; }
    finally { stop.remove(); }
  };
</script>`;
