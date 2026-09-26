const scenes = {
  working: { image: 'working', alt: '鲸鱼娘在笔记本电脑前认真工作', bubble: '这个我来。', title: '交给我，你去忙吧。', text: '任务开始，鲸鱼娘回到工位。让运行中的 Agent 有一个看得见的身影，进度也多了一份真实感。', status: '● 工作中' },
  lunch: { image: 'idle-lunch', alt: '鲸鱼娘捧着碗吃午饭', bubble: '先补充一点能量～', title: '吃饱了，才有力气嘛。', text: '空闲时，办公室也不会变得冷清。吃饭、散步、小憩，这些可爱的日常让等待多了一点生活气息。', status: '● 休息中' },
  finished: { image: 'finished', alt: '鲸鱼娘为完成任务开心庆祝', bubble: '搞定了！', title: '这份小小的成就，分你一半。', text: '任务完成，鲸鱼娘也会开心一下。在应用中，完成状态由真实运行结果触发，让每一个结果都有回应。', status: '● 已完成' }
};
document.querySelectorAll('[data-state]').forEach(button => {
  button.addEventListener('click', () => {
    const scene = scenes[button.dataset.state];
    document.querySelectorAll('[data-state]').forEach(item => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    const image = document.getElementById('demoImage');
    image.src = `assets/${scene.image}.webp`;
    image.alt = scene.alt;
    document.getElementById('demoBubble').textContent = scene.bubble;
    document.getElementById('demoTitle').textContent = scene.title;
    document.getElementById('demoText').textContent = scene.text;
    document.getElementById('demoStatus').textContent = scene.status;
  });
});

// Adapted from photo/output/b-plan-player.html; original 83 ms timing and frame order.
const walkDirections = { left: {count:15,label:'向左'}, right: {count:15,label:'向右'}, up: {count:14,label:'向后'}, down: {count:15,label:'向前'} };
const walkSprite = document.getElementById('walkSprite');
const walkPlay = document.getElementById('walkPlay');
const walkStatus = document.getElementById('walkStatus');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let walkDirection = 'right', walkFrame = 0, walkPlaying = false, walkVisible = false, walkTimer;
const walkImages = Object.keys(walkDirections).map(direction => { const img = new Image(); img.src = `assets/walk/${direction}.webp`; return img; });
function renderWalk() {
  const direction = walkDirections[walkDirection];
  walkSprite.style.backgroundImage = `url('assets/walk/${walkDirection}.webp')`;
  walkSprite.style.backgroundSize = `${direction.count * 280}px 280px`;
  walkSprite.style.backgroundPosition = `${-walkFrame * 280}px 0`;
  walkSprite.setAttribute('aria-label', `鲸鱼娘${direction.label}行走动画`);
}
function syncWalk() {
  clearInterval(walkTimer);
  walkPlay.textContent = walkPlaying ? '暂停行走' : '播放行走';
  walkPlay.setAttribute('aria-pressed', String(walkPlaying));
  walkStatus.textContent = `${walkDirections[walkDirection].label}行走 · ${walkPlaying ? '播放中' : '已暂停'}`;
  if (walkPlaying && walkVisible && !document.hidden) walkTimer = setInterval(() => {
    walkFrame = (walkFrame + 1) % walkDirections[walkDirection].count;
    renderWalk();
  }, 83);
}
document.querySelectorAll('[data-walk]').forEach(button => button.addEventListener('click', () => {
  walkDirection = button.dataset.walk; walkFrame = 0;
  document.querySelectorAll('[data-walk]').forEach(item => item.setAttribute('aria-pressed',String(item === button)));
  renderWalk(); syncWalk();
}));
walkPlay.addEventListener('click', () => { walkPlaying = !walkPlaying; syncWalk(); });
new IntersectionObserver(entries => { walkVisible = entries[0].isIntersecting; syncWalk(); }).observe(walkSprite);
document.addEventListener('visibilitychange', syncWalk);
reducedMotion.addEventListener('change', () => { if(reducedMotion.matches){walkPlaying=false;syncWalk();} });
walkPlaying = !reducedMotion.matches; renderWalk(); syncWalk();

const downloadSelect = document.getElementById('downloadPlatform');
const downloadButton = document.getElementById('directDownload');
const downloadStatus = document.getElementById('downloadStatus');
const versionSelect = document.getElementById('releaseVersion');
const packageMeta = document.getElementById('packageMeta');
const releaseNotes = document.getElementById('releaseNotes');
const labels = {windows:'Windows x64 · 安装版', 'windows-portable':'Windows x64 · 便携版', mac:'macOS · Apple Silicon', 'mac-intel':'macOS · Intel'};
let releases = [];
function detectDesktop(platform, userAgent, touchPoints = 0) {
  if (/Android|iPhone|iPad|iPod/i.test(userAgent) || (/Mac/i.test(platform) && touchPoints > 1)) return '';
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return 'windows';
  if (/Mac/i.test(platform) || /Macintosh/i.test(userAgent)) return 'mac';
  return '';
}
const detectedPlatform = detectDesktop(navigator.userAgentData?.platform || navigator.platform, navigator.userAgent, navigator.maxTouchPoints);
function selectedRelease(){return releases.find(r=>r.version===versionSelect.value);}
function selectedAsset(){return selectedRelease()?.assets.find(a=>a.platform===downloadSelect.value);}
function updateDownload(){
  const asset = selectedAsset();
  downloadButton.disabled = !asset;
  downloadButton.textContent = asset ? `下载 ${labels[asset.platform]} ↓` : '请选择可用的版本';
  downloadStatus.textContent = asset ? (asset.platform==='mac' ? '适用于 M 系列芯片；Intel Mac 请选择 Intel 版本。' : '完整安装包，由本站服务器提供下载。') : '请选择系统与安装包。';
  packageMeta.textContent = asset ? `${selectedRelease().version} · ${(asset.size/1048576).toFixed(1)} MB · ${selectedRelease().publishedAt.slice(0,10)}` : '';
}
function updatePlatforms(){
  const wanted = downloadSelect.value || detectedPlatform;
  const release = selectedRelease();
  downloadSelect.replaceChildren(new Option('请选择系统',''));
  for(const asset of release.assets) downloadSelect.add(new Option(labels[asset.platform],asset.platform));
  downloadSelect.value = release.assets.some(a=>a.platform===wanted) ? wanted : (wanted==='windows' && release.assets.some(a=>a.platform==='windows-portable') ? 'windows-portable' : '');
  releaseNotes.href = release.notesUrl;
  updateDownload();
}
versionSelect.addEventListener('change',updatePlatforms);
downloadSelect.addEventListener('change',updateDownload);
downloadButton.disabled = true;
(async()=>{
  try{
    const response=await fetch('/downloads/index.json',{cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok) throw new Error('Catalog unavailable');
    const catalog=await response.json();
    releases=catalog.releases.filter(r=>typeof r.version==='string' && typeof r.publishedAt==='string' && r.notesUrl.startsWith('https://github.com/Lxiayu/DshCockpit/releases/') && Array.isArray(r.assets)).map(r=>({...r,assets:r.assets.filter(a=>labels[a.platform] && /^\/downloads\/[A-Za-z0-9._-]+\/DshCockpit-[A-Za-z0-9._-]+$/.test(a.url) && a.size>0)})).filter(r=>r.assets.length);
    if(!releases.length) throw new Error('No mirrored installers');
    versionSelect.replaceChildren();
    releases.forEach((r,i)=>versionSelect.add(new Option(`${r.version}${i===0?' · 最新已同步稳定版':''}`,r.version)));
    versionSelect.disabled=false; downloadSelect.value=detectedPlatform; updatePlatforms();
  }catch{
    versionSelect.replaceChildren(new Option('版本列表暂不可用',''));
    downloadStatus.textContent='本站安装包暂未就绪，请通过旁边的 GitHub 下载；服务器同步恢复后将提供直链。';
    downloadButton.textContent='服务器下载待就绪';
  }
})();
downloadButton.addEventListener('click',async()=>{
  const asset=selectedAsset(); if(!asset)return;
  downloadButton.disabled=true;downloadStatus.textContent='正在连接下载服务器…';
  try{
    const response=await fetch(asset.url,{method:'HEAD',cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok || /text\/html/i.test(response.headers.get('content-type')||''))throw new Error('Unavailable');
    const link=document.createElement('a');link.href=asset.url;link.download=asset.name;document.body.appendChild(link);link.click();link.remove();
    downloadStatus.textContent='已发起下载，请查看浏览器下载列表。';
  }catch{downloadStatus.textContent='下载暂时不可用，请稍后重试，或通过 GitHub 获取此版本。';}
  finally{downloadButton.disabled=false;}
});
