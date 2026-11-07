(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const MAX_CAPTURE_SIDE = 2400;
  const ASPECTS = { '4:3': 4 / 3, '3:2': 3 / 2, '1:1': 1 };

  const DEFAULTS = {
    delay: 86400000,
    aspect: '3:2',
    blur: true,
    grid: false,
    timer: 0,
    grain: true,
    dateStamp: true,
    stampOrder: 'DMY',
    stampColor: 'orange'
  };

  const state = {
    settings: { ...DEFAULTS },
    tab: 'camera',
    rolls: [],
    roll: null,
    stream: null,
    facing: 'environment',
    flash: true,
    busy: false,
    countdown: null,
    developing: false,
    labEls: new Map(),
    listUrls: [],
    view: null,
    viewerIndex: 0,
    lastPersist: 0
  };

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pad2 = (n) => String(n).padStart(2, '0');

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function vibrate(p) {
    if (navigator.vibrate) {
      try { navigator.vibrate(p); } catch (e) {}
    }
  }

  function fmtCountdown(ms) {
    const total = Math.ceil(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return (d ? d + 'd ' : '') + pad2(h) + ':' + pad2(m) + ':' + pad2(s);
  }

  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtTime = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of [].concat(children)) if (c) n.append(c);
    return n;
  }

  function dialog(title, text, okLabel = 'OK', cancelLabel = 'Cancel') {
    return new Promise((resolve) => {
      $('#dialog-title').textContent = title;
      $('#dialog-text').textContent = text;
      $('#dialog-ok').textContent = okLabel;
      const cancel = $('#dialog-cancel');
      cancel.textContent = cancelLabel || '';
      cancel.hidden = !cancelLabel;
      $('#dialog').hidden = false;
      const done = (v) => {
        $('#dialog').hidden = true;
        $('#dialog-ok').onclick = cancel.onclick = null;
        resolve(v);
      };
      $('#dialog-ok').onclick = () => done(true);
      cancel.onclick = () => done(false);
    });
  }

  function setTab(tab) {
    state.tab = tab;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + tab));
    $$('.tabbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'camera') {
      renderCamera();
      sizeViewfinder();
      maybeStartStream();
    } else {
      cancelTimer();
      stopStream();
    }
    if (tab === 'lab') renderLab();
    if (tab === 'rolls') renderRolls();
  }

  function advanceClock(roll) {
    const now = Date.now();
    const delta = now - roll.lastCheck;
    if (delta > 0) roll.elapsed += delta;
    roll.lastCheck = now;
    return Math.max(0, roll.delay - roll.elapsed, roll.readyAt - now);
  }

  const labRolls = () => state.rolls.filter((r) => r.status === 'lab').sort((a, b) => a.sentAt - b.sentAt);

  async function persistLabClocks() {
    const lab = labRolls();
    for (const r of lab) advanceClock(r);
    if (lab.length) await DB.putMany(lab.map((r) => ['rolls', r]));
    state.lastPersist = Date.now();
  }

  async function refresh() {
    state.rolls = await DB.all('rolls');
    state.roll = state.rolls.find((r) => r.status === 'shooting') || null;
    await persistLabClocks();
    const ready = labRolls().find((r) => advanceClock(r) === 0);
    if (ready && !state.developing && !state.busy && !state.countdown) {
      await developRoll(ready);
      return refresh();
    }
    $('#lab-dot').hidden = !labRolls().length;
    if (state.tab === 'camera') renderCamera();
    if (state.tab === 'lab') renderLab();
    if (state.tab === 'rolls') renderRolls();
  }

  function renderLab() {
    const lab = labRolls();
    const list = $('#lab-list');
    list.innerHTML = '';
    state.labEls.clear();
    $('#lab-empty').hidden = !!lab.length;
    for (const r of lab) {
      const cd = el('div', { class: 'countdown' });
      const bar = el('i');
      list.append(
        el('div', { class: 'card lab-card' }, [
          el('div', { class: 'lab-row' }, [
            el('b', { text: `${r.shots} photo${r.shots === 1 ? '' : 's'}` }),
            el('span', { text: 'sent ' + fmtTime(r.sentAt) })
          ]),
          el('div', { class: 'lab-label', text: 'Ready in' }),
          cd,
          el('div', { class: 'bar' }, bar)
        ])
      );
      state.labEls.set(r.id, { cd, bar });
    }
    updateCountdowns();
  }

  function updateCountdowns() {
    for (const r of labRolls()) {
      const remaining = advanceClock(r);
      const refs = state.labEls.get(r.id);
      if (!refs) continue;
      refs.cd.textContent = remaining > 0 ? fmtCountdown(remaining) : 'Ready';
      const pct = Math.min(100, Math.max(0, (1 - remaining / r.delay) * 100));
      refs.bar.style.width = pct.toFixed(2) + '%';
    }
  }

  function renderRolls() {
    state.listUrls.forEach((u) => URL.revokeObjectURL(u));
    state.listUrls = [];
    const dev = state.rolls.filter((r) => r.status === 'developed').sort((a, b) => b.developedAt - a.developedAt);
    const list = $('#dev-list');
    list.innerHTML = '';
    $('#dev-empty').hidden = !!dev.length;
    for (const r of dev) {
      const thumb = el('div', { class: 'thumb' });
      list.append(
        el('button', { class: 'dev-card', onclick: () => openRoll(r.id) }, [
          thumb,
          el('div', { class: 'meta' }, [el('b', { text: fmtDate(r.createdAt) }), el('span', { text: `${r.shots} photos` })])
        ])
      );
      if (r.coverId) {
        DB.get('prints', r.coverId).then((p) => {
          if (!p) return;
          const u = URL.createObjectURL(p.blob);
          state.listUrls.push(u);
          thumb.style.backgroundImage = `url("${u}")`;
        });
      }
    }
  }

  async function tick() {
    if (document.hidden) return;
    const lab = labRolls();
    $('#lab-dot').hidden = !lab.length;
    if (!lab.length) return;
    updateCountdowns();
    if (Date.now() - state.lastPersist > 15000) persistLabClocks();
    if (!state.developing && !state.busy && !state.countdown && lab.some((r) => advanceClock(r) === 0)) refresh();
  }

  async function developRoll(roll) {
    state.developing = true;
    stopStream();
    const overlay = $('#developing');
    const text = $('#developing-text');
    overlay.hidden = false;
    try {
      const photos = await DB.byRoll('photos', roll.id);
      const existing = new Set((await DB.byRoll('prints', roll.id)).map((p) => p.id));
      let n = 0;
      for (const photo of photos) {
        n++;
        text.textContent = `Developing roll… ${n} / ${photos.length}`;
        if (existing.has(photo.id)) continue;
        await sleep(30);
        try {
          const blob = await Film.develop(photo.raw, {
            seed: hash(photo.id),
            takenAt: photo.takenAt,
            grain: roll.grain !== false,
            dateStamp: roll.dateStamp,
            stampOrder: roll.stampOrder || 'YMD',
            stampColor: roll.stampColor || 'orange'
          });
          await DB.put('prints', { id: photo.id, rollId: roll.id, index: photo.index, blob });
        } catch (e) {
          console.error('Could not develop frame', photo.index, e);
        }
      }
      roll.status = 'developed';
      roll.developedAt = Date.now();
      roll.coverId = photos.length ? photos[0].id : null;
      await DB.put('rolls', roll);
    } finally {
      overlay.hidden = true;
      state.developing = false;
      if (state.tab === 'camera') maybeStartStream();
    }
  }

  async function newRoll(size) {
    requestPersistence();
    const roll = { id: uid(), size, shots: 0, status: 'shooting', createdAt: Date.now() };
    await DB.put('rolls', roll);
    state.roll = roll;
    state.rolls.push(roll);
    renderCamera();
    maybeStartStream();
  }

  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        if (!already) await navigator.storage.persist();
      }
    } catch (e) {}
  }

  function portraitRatio() {
    return 1 / ASPECTS[state.settings.aspect];
  }

  function sizeViewfinder() {
    const area = $('.vf-area');
    const vf = $('#vf');
    if (!area.clientWidth) return;
    const cs = getComputedStyle(area);
    const aw = area.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const ah = area.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const ratio = portraitRatio();
    let w = Math.min(aw, ah * ratio);
    let h = w / ratio;
    vf.style.width = Math.floor(w) + 'px';
    vf.style.height = Math.floor(h) + 'px';
  }

  function vfMessage(text) {
    const m = $('#vf-msg');
    m.hidden = !text;
    m.textContent = text || '';
  }

  function maybeStartStream() {
    const r = state.roll;
    if (state.tab !== 'camera' || document.hidden || state.developing) return;
    if (!r || r.shots >= r.size) {
      stopStream();
      return;
    }
    if (!state.stream) startStream();
  }

  async function startStream() {
    stopStream();
    const video = $('#video');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      vfMessage('Camera not available here. Open Rollcam in Safari over https.');
      return;
    }
    vfMessage('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } }
      });
      if (state.tab !== 'camera' || document.hidden || !state.roll || state.roll.shots >= state.roll.size) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      state.stream = stream;
      video.srcObject = stream;
      video.classList.toggle('mirror', state.facing === 'user');
      await video.play().catch(() => {});
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        vfMessage('Camera access is blocked.\nTap here to try again.');
        dialog(
          'Camera access denied',
          'Rollcam needs the camera to take photos. On iPhone open Settings → Apps → Safari → Camera and choose Allow or Ask, then come back and tap the viewfinder.',
          'OK',
          null
        );
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        vfMessage('No camera found.');
      } else {
        vfMessage('Camera error.\nTap here to try again.');
      }
    }
  }

  function stopStream() {
    if (state.stream) {
      state.stream.getTracks().forEach((t) => t.stop());
      state.stream = null;
    }
    const v = $('#video');
    if (v) v.srcObject = null;
  }

  function renderCamera() {
    const r = state.roll;
    const s = state.settings;
    const vf = $('#vf');
    vf.classList.toggle('blur', s.blur);
    $('#vf-grid').hidden = !s.grid || !r;
    $('#vf-load').hidden = !!r;
    const front = state.facing === 'user';
    $('#btn-flip').setAttribute('aria-checked', String(front));
    $('#btn-flash').disabled = !front;
    $('#btn-flash').classList.toggle('on', front && state.flash);
    $('#btn-timer').classList.toggle('on', s.timer > 0);
    $('#timer-badge').hidden = !s.timer;
    $('#timer-badge').textContent = s.timer ? s.timer + 's' : '';

    if (!r) {
      $('#counter').textContent = '-- / --';
      $('#btn-shutter').hidden = false;
      $('#btn-shutter').classList.add('disabled');
      $('#btn-send').hidden = true;
      $('#btn-early').disabled = true;
      vfMessage('');
      return;
    }
    const full = r.shots >= r.size;
    $('#counter').textContent = `${pad2(r.shots)} / ${pad2(r.size)}`;
    $('#btn-shutter').hidden = full;
    $('#btn-shutter').classList.remove('disabled');
    $('#btn-send').hidden = !full;
    $('#btn-early').disabled = full;
    if (full) {
      stopStream();
      vfMessage('Roll finished.\nSend it to the lab.');
    } else if ($('#vf-msg').textContent.startsWith('Roll finished')) {
      vfMessage('');
    }
  }

  function cancelTimer() {
    if (state.countdown) {
      clearInterval(state.countdown);
      state.countdown = null;
      $('#vf-timer').hidden = true;
    }
  }

  function onShutter() {
    const r = state.roll;
    if (!r || state.busy || r.shots >= r.size) return;
    if (state.countdown) {
      cancelTimer();
      return;
    }
    const video = $('#video');
    if (!state.stream || video.readyState < 2 || !video.videoWidth) {
      startStream();
      return;
    }
    const secs = state.settings.timer;
    if (!secs) {
      shoot();
      return;
    }
    let left = secs;
    const t = $('#vf-timer');
    t.textContent = left;
    t.hidden = false;
    state.countdown = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        cancelTimer();
        shoot();
      } else {
        t.textContent = left;
      }
    }, 1000);
  }

  function cropToAspect(vw, vh) {
    const target = ASPECTS[state.settings.aspect];
    const long = Math.max(vw, vh), short = Math.min(vw, vh);
    let cl = long, cs = short;
    if (long / short > target) cl = short * target;
    else cs = long / target;
    const cw = vw >= vh ? cl : cs;
    const ch = vw >= vh ? cs : cl;
    return { sx: (vw - cw) / 2, sy: (vh - ch) / 2, sw: cw, sh: ch };
  }

  async function shoot() {
    const r = state.roll;
    const video = $('#video');
    if (!r || state.busy || r.shots >= r.size || !state.stream || !video.videoWidth) return;
    state.busy = true;
    const overlay = $('#flash-overlay');
    const useFlash = state.facing === 'user' && state.flash;
    try {
      if (useFlash) {
        overlay.classList.add('fire');
        await sleep(220);
      }
      const { sx, sy, sw, sh } = cropToAspect(video.videoWidth, video.videoHeight);
      const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(sw, sh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw * scale);
      canvas.height = Math.round(sh * scale);
      const ctx = canvas.getContext('2d');
      if (state.facing === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      if (useFlash) overlay.classList.remove('fire');
      vibrate(15);
      video.classList.add('blink');
      setTimeout(() => video.classList.remove('blink'), 110);

      const raw = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('Capture failed'))), 'image/jpeg', 0.92)
      );
      canvas.width = canvas.height = 0;
      const photo = { id: uid(), rollId: r.id, index: r.shots, raw, takenAt: Date.now(), facing: state.facing };
      r.shots += 1;
      await DB.putMany([['photos', photo], ['rolls', r]]);
      renderCamera();
    } catch (e) {
      console.error(e);
      overlay.classList.remove('fire');
      dialog('Shot not saved', 'Something went wrong saving that frame. It did not use up an exposure.', 'OK', null);
    } finally {
      state.busy = false;
    }
  }

  async function sendToLab() {
    const r = state.roll;
    if (!r) return;
    cancelTimer();
    stopStream();
    if (r.shots === 0) {
      await DB.deleteRoll(r.id);
    } else {
      const now = Date.now();
      const s = state.settings;
      Object.assign(r, {
        status: 'lab',
        discarded: r.size - r.shots,
        sentAt: now,
        delay: s.delay,
        readyAt: now + s.delay,
        elapsed: 0,
        lastCheck: now,
        grain: s.grain,
        dateStamp: s.dateStamp,
        stampOrder: s.stampOrder,
        stampColor: s.stampColor
      });
      await DB.put('rolls', r);
    }
    state.roll = null;
    await refresh();
    setTab(r.shots ? 'lab' : 'camera');
  }

  async function developEarly() {
    const r = state.roll;
    if (!r) return;
    const left = r.size - r.shots;
    if (r.shots === 0) {
      const ok = await dialog('Unload this roll?', 'You haven’t taken any photos yet. The roll will be thrown away.', 'Unload', 'Cancel');
      if (ok) sendToLab();
      return;
    }
    const ok = await dialog(
      'Develop early?',
      `The ${r.shots} photo${r.shots === 1 ? '' : 's'} you took go to the lab now. The ${left} unused exposure${left === 1 ? '' : 's'} will be thrown away.`,
      'Send to lab',
      'Keep shooting'
    );
    if (ok) sendToLab();
  }

  async function openRoll(id) {
    const roll = await DB.get('rolls', id);
    if (!roll || roll.status !== 'developed') return;
    closeRoll();
    const prints = await DB.byRoll('prints', id);
    state.view = {
      roll,
      prints: prints.map((p) => ({ id: p.id, index: p.index, blob: p.blob, url: URL.createObjectURL(p.blob) }))
    };
    $('#roll-title').textContent = fmtDate(roll.createdAt);
    $('#roll-sub').textContent = `${prints.length} photo${prints.length === 1 ? '' : 's'} · developed ${fmtDate(roll.developedAt)}`;
    const grid = $('#grid');
    grid.innerHTML = '';
    state.view.prints.forEach((p, i) => {
      const b = el('button', { 'aria-label': `Photo ${i + 1}`, onclick: () => openViewer(i) });
      b.style.backgroundImage = `url("${p.url}")`;
      grid.append(b);
    });
    $('#roll').hidden = false;
  }

  function closeRoll() {
    if (state.view) state.view.prints.forEach((p) => URL.revokeObjectURL(p.url));
    state.view = null;
    $('#roll').hidden = true;
  }

  function openViewer(i) {
    if (!state.view || !state.view.prints.length) return;
    const n = state.view.prints.length;
    state.viewerIndex = (i + n) % n;
    $('#viewer-img').src = state.view.prints[state.viewerIndex].url;
    $('#viewer-count').textContent = `${state.viewerIndex + 1} / ${n}`;
    $('#viewer').hidden = false;
  }

  function fileFor(p) {
    const d = new Date(state.view.roll.createdAt);
    const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    return new File([p.blob], `rollcam-${stamp}-${pad2(p.index + 1)}.jpg`, { type: 'image/jpeg' });
  }

  async function saveFiles(files) {
    if (navigator.canShare && navigator.canShare({ files })) {
      try {
        await navigator.share({ files });
      } catch (e) {
        if (e && e.name !== 'AbortError') {
          dialog('Couldn’t open the share sheet', 'Try saving fewer photos at once, or save them one by one from the viewer.', 'OK', null);
        }
      }
      return;
    }
    for (const f of files) {
      const url = URL.createObjectURL(f);
      const a = el('a', { href: url, download: f.name });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      await sleep(250);
    }
  }

  async function loadSettings() {
    for (const k of Object.keys(DEFAULTS)) state.settings[k] = await DB.getMeta(k, DEFAULTS[k]);
  }

  function setSetting(k, v) {
    state.settings[k] = v;
    DB.setMeta(k, v);
    if (k === 'aspect') sizeViewfinder();
    renderCamera();
  }

  function renderSettings() {
    $$('#settings .seg').forEach((seg) => {
      const k = seg.dataset.setting;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(state.settings[k])));
    });
    $$('#settings .tgl').forEach((t) => (t.checked = !!state.settings[t.dataset.setting]));
  }

  async function renderStorage() {
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        $('#st-space').textContent = (est.usage / 1048576).toFixed(1) + ' MB';
      }
      $('#st-rolls').textContent = String((await DB.all('rolls')).filter((r) => r.status === 'developed').length);
      $('#st-photos').textContent = String(await DB.count('photos'));
      let note = '';
      if (navigator.storage && navigator.storage.persisted) {
        note = (await navigator.storage.persisted())
          ? 'Storage is persistent.'
          : 'Add Rollcam to your home screen so iOS keeps your photos.';
      }
      $('#st-note').textContent = note + ' There is no cloud backup.';
    } catch (e) {}
  }

  function openSettings() {
    renderSettings();
    renderStorage();
    $('#settings').hidden = false;
  }

  function setupSettings() {
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-settings-back').addEventListener('click', () => ($('#settings').hidden = true));
    $$('#settings .seg').forEach((seg) =>
      seg.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        const k = seg.dataset.setting;
        const v = typeof DEFAULTS[k] === 'number' ? Number(b.dataset.v) : b.dataset.v;
        setSetting(k, v);
        renderSettings();
      })
    );
    $$('#settings .tgl').forEach((t) => t.addEventListener('change', () => setSetting(t.dataset.setting, t.checked)));
    $('#btn-delete-all').addEventListener('click', async () => {
      const ok = await dialog(
        'Delete all data?',
        'Every roll and photo — in the camera, at the lab and developed — will be permanently deleted. This can’t be undone.',
        'Delete everything',
        'Cancel'
      );
      if (!ok) return;
      cancelTimer();
      stopStream();
      closeRoll();
      await DB.clearAll();
      await refresh();
      renderStorage();
    });
  }

  function setupCamera() {
    $('#btn-shutter').addEventListener('click', onShutter);
    $('#btn-flip').addEventListener('click', () => {
      state.facing = state.facing === 'user' ? 'environment' : 'user';
      renderCamera();
      if (state.stream) startStream();
    });
    $('#btn-flash').addEventListener('click', () => {
      state.flash = !state.flash;
      renderCamera();
    });
    $('#btn-timer').addEventListener('click', () => {
      const steps = [0, 2, 5, 10];
      setSetting('timer', steps[(steps.indexOf(state.settings.timer) + 1) % steps.length]);
    });
    $('#btn-send').addEventListener('click', sendToLab);
    $('#btn-early').addEventListener('click', developEarly);
    $$('.load-choice button').forEach((b) => b.addEventListener('click', () => newRoll(Number(b.dataset.size))));
    $('#vf-msg').addEventListener('click', () => {
      if (state.roll && state.roll.shots < state.roll.size) startStream();
    });
    window.addEventListener('resize', sizeViewfinder);
  }

  function setupRoll() {
    $('#btn-roll-back').addEventListener('click', closeRoll);
    $('#btn-save-all').addEventListener('click', () => {
      if (state.view) saveFiles(state.view.prints.map(fileFor));
    });
    $('#btn-delete-roll').addEventListener('click', async () => {
      if (!state.view) return;
      const ok = await dialog('Delete this roll?', 'These photos will be removed from Rollcam for good. Save any you want to keep first.', 'Delete', 'Cancel');
      if (!ok) return;
      await DB.deleteRoll(state.view.roll.id);
      closeRoll();
      refresh();
    });
  }

  function setupViewer() {
    const close = () => {
      $('#viewer').hidden = true;
      $('#viewer-img').removeAttribute('src');
    };
    $('#btn-viewer-close').addEventListener('click', close);
    $('#btn-viewer-save').addEventListener('click', () => {
      if (state.view) saveFiles([fileFor(state.view.prints[state.viewerIndex])]);
    });
    const stage = $('#viewer-stage');
    const img = $('#viewer-img');
    let startX = null, startY = 0;
    stage.addEventListener('pointerdown', (e) => { startX = e.clientX; startY = e.clientY; });
    stage.addEventListener('pointermove', (e) => {
      if (startX !== null) img.style.transform = `translateX(${(e.clientX - startX) * 0.6}px)`;
    });
    stage.addEventListener('pointerup', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      startX = null;
      img.style.transform = '';
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) openViewer(state.viewerIndex + (dx < 0 ? 1 : -1));
      else if (dy > 120) close();
    });
    stage.addEventListener('pointercancel', () => { startX = null; img.style.transform = ''; });
    document.addEventListener('keydown', (e) => {
      if ($('#viewer').hidden) return;
      if (e.key === 'ArrowRight') openViewer(state.viewerIndex + 1);
      if (e.key === 'ArrowLeft') openViewer(state.viewerIndex - 1);
      if (e.key === 'Escape') close();
    });
  }

  function setupLifecycle() {
    $$('.tabbtn').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        persistLabClocks();
        cancelTimer();
        stopStream();
      } else {
        refresh().then(maybeStartStream);
      }
    });
    window.addEventListener('pagehide', () => {
      persistLabClocks();
      stopStream();
    });
  }

  async function init() {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
    $('#install-hint').hidden = !!standalone;

    setupCamera();
    setupRoll();
    setupViewer();
    setupSettings();
    setupLifecycle();

    try {
      await DB.open();
      await loadSettings();
      requestPersistence();
      await refresh();
      setTab(labRolls().length ? 'lab' : 'camera');
    } catch (e) {
      console.error(e);
      setTab('camera');
      dialog('Storage unavailable', 'Rollcam couldn’t open its on-device storage. Private Browsing can block it — try a normal Safari tab or the home-screen app.', 'OK', null);
    }
    setInterval(tick, 1000);
  }

  init();
})();
