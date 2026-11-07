(() => {
  const $ = (s) => document.querySelector(s);
  const WIND_DISTANCE = 240;
  const TICK_EVERY = 22;
  const MAX_CAPTURE_SIDE = 2400;

  const state = {
    settings: { delay: 86400000, dateStamp: true },
    rolls: [],
    roll: null,
    stream: null,
    facing: 'environment',
    flash: true,
    busy: false,
    developing: false,
    windProgress: 0,
    labEls: new Map(),
    homeUrls: [],
    view: null,
    viewerIndex: 0,
    lastPersist: 0
  };

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

  let audio = null;
  function ac() {
    if (!audio) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      audio = new AC();
    }
    if (audio.state === 'suspended') audio.resume();
    return audio;
  }

  function noise(duration, freq, gain, q = 1) {
    const a = ac();
    if (!a) return;
    const len = Math.floor(a.sampleRate * duration);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = a.createBufferSource();
    src.buffer = buf;
    const f = a.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const g = a.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(a.destination);
    src.start();
  }

  const sound = {
    shutter() { noise(0.05, 3000, 0.9, 0.7); setTimeout(() => noise(0.07, 1800, 0.7, 0.8), 60); },
    tick() { noise(0.012, 4200, 0.35, 2); },
    clunk() { noise(0.09, 600, 1.2, 1); }
  };

  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (id !== 'camera') stopStream();
  }

  function fmtCountdown(ms) {
    const total = Math.ceil(ms / 1000);
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return (d ? d + 'd ' : '') + pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const fmtTime = (t) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });

  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
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

  function advanceClock(roll) {
    const now = Date.now();
    const delta = now - roll.lastCheck;
    if (delta > 0) roll.elapsed += delta;
    roll.lastCheck = now;
    return Math.max(0, roll.delay - roll.elapsed, roll.readyAt - now);
  }

  async function persistLabClocks() {
    const lab = state.rolls.filter((r) => r.status === 'lab');
    for (const r of lab) advanceClock(r);
    if (lab.length) await DB.putMany(lab.map((r) => ['rolls', r]));
    state.lastPersist = Date.now();
  }

  async function loadRolls() {
    state.rolls = await DB.all('rolls');
    state.roll = state.rolls.find((r) => r.status === 'shooting') || null;
  }

  async function refreshHome() {
    await loadRolls();
    const lab = state.rolls.filter((r) => r.status === 'lab').sort((a, b) => a.sentAt - b.sentAt);
    for (const r of lab) advanceClock(r);
    if (lab.length) await DB.putMany(lab.map((r) => ['rolls', r]));
    const ready = lab.find((r) => advanceClock(r) === 0);
    if (ready && !state.developing) {
      await developRoll(ready);
      return refreshHome();
    }
    renderHome();
  }

  function renderHome() {
    state.homeUrls.forEach((u) => URL.revokeObjectURL(u));
    state.homeUrls = [];

    const slot = $('#active-slot');
    slot.innerHTML = '';
    if (state.roll) {
      const r = state.roll;
      const left = r.size - r.shots;
      slot.append(
        el('div', { class: 'card active-card' }, [
          el('h2', { text: 'Roll in camera' }),
          el('p', {
            text: left > 0
              ? `${r.size} exp · ${left} left${r.needsWind ? ' · wind on before the next shot' : ''}`
              : `${r.size} exp · roll finished, ready for the lab`
          }),
          el('button', { class: 'big-btn', text: left > 0 ? 'Keep shooting' : 'Open camera', onclick: openCamera })
        ])
      );
    } else {
      slot.append(
        el('div', { class: 'card load-card' }, [
          el('h2', { text: 'Load a new roll' }),
          el('p', { text: 'No previews. No retakes. Wait for the lab.' }),
          el('div', { class: 'roll-choice' }, [
            el('button', { html: '24<small>exposures</small>', onclick: () => newRoll(24) }),
            el('button', { html: '36<small>exposures</small>', onclick: () => newRoll(36) })
          ])
        ])
      );
    }

    const lab = state.rolls.filter((r) => r.status === 'lab').sort((a, b) => a.sentAt - b.sentAt);
    const labList = $('#lab-list');
    labList.innerHTML = '';
    state.labEls.clear();
    $('#lab-title').hidden = !lab.length;
    for (const r of lab) {
      const cd = el('div', { class: 'countdown' });
      const bar = el('i');
      labList.append(
        el('div', { class: 'card lab-card' }, [
          el('div', { class: 'lab-row' }, [
            el('b', { text: `${r.shots} photo${r.shots === 1 ? '' : 's'}` }),
            el('span', { text: 'sent ' + fmtTime(r.sentAt) })
          ]),
          el('div', { class: 'small', text: 'Ready in' }),
          cd,
          el('div', { class: 'bar' }, bar)
        ])
      );
      state.labEls.set(r.id, { cd, bar });
    }
    updateCountdowns();

    const dev = state.rolls.filter((r) => r.status === 'developed').sort((a, b) => b.developedAt - a.developedAt);
    const devList = $('#dev-list');
    devList.innerHTML = '';
    $('#dev-title').hidden = !dev.length;
    for (const r of dev) {
      const thumb = el('div', { class: 'thumb' });
      devList.append(
        el('button', { class: 'dev-card', onclick: () => openRoll(r.id) }, [
          thumb,
          el('div', { class: 'meta' }, [el('b', { text: fmtDate(r.createdAt) }), el('span', { text: `${r.shots} photos` })])
        ])
      );
      if (r.coverId) {
        DB.get('prints', r.coverId).then((p) => {
          if (!p) return;
          const u = URL.createObjectURL(p.blob);
          state.homeUrls.push(u);
          thumb.style.backgroundImage = `url("${u}")`;
        });
      }
    }

    if (!state.roll && !lab.length && !dev.length) {
      devList.append(el('p', { class: 'empty', text: 'Your developed rolls will show up here.' }));
      $('#dev-list').classList.remove('dev-list');
    } else {
      $('#dev-list').classList.add('dev-list');
    }
  }

  function updateCountdowns() {
    for (const r of state.rolls) {
      if (r.status !== 'lab') continue;
      const refs = state.labEls.get(r.id);
      const remaining = advanceClock(r);
      if (!refs) continue;
      refs.cd.textContent = remaining > 0 ? fmtCountdown(remaining) : 'Ready!';
      const pct = Math.min(100, Math.max(0, (1 - remaining / r.delay) * 100));
      refs.bar.style.width = pct.toFixed(2) + '%';
    }
  }

  async function tick() {
    if (document.hidden) return;
    const lab = state.rolls.filter((r) => r.status === 'lab');
    if (!lab.length) return;
    updateCountdowns();
    if (Date.now() - state.lastPersist > 15000) persistLabClocks();
    if ($('#home').classList.contains('active') && !state.developing && lab.some((r) => advanceClock(r) === 0)) {
      refreshHome();
    }
  }

  async function developRoll(roll) {
    state.developing = true;
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
            dateStamp: roll.dateStamp,
            takenAt: photo.takenAt
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
    }
  }

  async function newRoll(size) {
    ac();
    requestPersistence();
    const roll = { id: uid(), size, shots: 0, status: 'shooting', needsWind: false, createdAt: Date.now() };
    await DB.put('rolls', roll);
    state.roll = roll;
    openCamera();
  }

  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        const already = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        if (!already) await navigator.storage.persist();
      }
    } catch (e) {}
  }

  function openCamera() {
    if (!state.roll) return;
    ac();
    state.windProgress = 0;
    show('camera');
    renderCamera();
    if (state.roll.shots < state.roll.size) startStream();
  }

  function vfMessage(text) {
    const m = $('#vf-msg');
    m.hidden = !text;
    m.textContent = text || '';
  }

  async function startStream() {
    stopStream();
    const video = $('#video');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      vfMessage('Camera not available here. Open Rollcam in Safari over https.');
      return;
    }
    vfMessage('Starting camera…');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: state.facing }, width: { ideal: 1920 }, height: { ideal: 1440 } }
      });
      if (!$('#camera').classList.contains('active') || document.hidden) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      state.stream = stream;
      video.srcObject = stream;
      video.classList.toggle('mirror', state.facing === 'user');
      video.onloadedmetadata = () => {
        if (video.videoWidth && video.videoHeight) {
          document.querySelector('.vf-bezel').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
        }
      };
      await video.play().catch(() => {});
      vfMessage('');
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        vfMessage('Camera blocked. Tap to retry.');
        dialog(
          'Camera access denied',
          'Rollcam needs the camera to take photos. On iPhone open Settings → Apps → Safari → Camera and choose Allow or Ask, then come back and tap the viewfinder to try again.',
          'OK',
          null
        );
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        vfMessage('No camera found.');
      } else {
        vfMessage('Camera error. Tap to retry.');
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
    if (!r) return;
    const left = r.size - r.shots;
    const full = left <= 0;
    $('#counter').textContent = String(left);
    $('#roll-label').textContent = `${r.size} EXP`;
    $('#btn-shutter').classList.toggle('disabled', r.needsWind || full);
    $('#btn-shutter').hidden = full;
    const wheel = $('#wheel');
    wheel.classList.toggle('locked', !r.needsWind);
    const hint = $('#wheel-hint');
    hint.textContent = full ? 'END' : r.needsWind ? 'WIND ▼' : 'READY';
    hint.classList.toggle('ready', !r.needsWind);
    wheel.setAttribute('aria-valuenow', String(Math.round((state.windProgress / WIND_DISTANCE) * 100)));
    $('#btn-send').hidden = !full;
    $('#btn-early').hidden = full;
    const front = state.facing === 'user';
    $('#flip-label').textContent = front ? 'FRONT' : 'BACK';
    $('#btn-flash').disabled = !front;
    $('#flash-led').classList.toggle('on', front && state.flash);
    $('#flash-label').textContent = front ? (state.flash ? 'FLASH ON' : 'FLASH OFF') : 'NO FLASH';
    if (full) {
      stopStream();
      vfMessage('Roll finished');
    }
  }

  async function shoot() {
    const r = state.roll;
    if (!r || state.busy || r.shots >= r.size) return;
    if (r.needsWind) {
      const w = $('#wheel');
      w.classList.remove('nudge');
      void w.offsetWidth;
      w.classList.add('nudge');
      vibrate([20, 40, 20]);
      return;
    }
    const video = $('#video');
    if (!state.stream || video.readyState < 2 || !video.videoWidth) {
      startStream();
      return;
    }
    state.busy = true;
    const overlay = $('#flash-overlay');
    const useFlash = state.facing === 'user' && state.flash;
    try {
      if (useFlash) {
        overlay.classList.add('fire');
        await sleep(220);
      }
      const vw = video.videoWidth, vh = video.videoHeight;
      const scale = Math.min(1, MAX_CAPTURE_SIDE / Math.max(vw, vh));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vw * scale);
      canvas.height = Math.round(vh * scale);
      const ctx = canvas.getContext('2d');
      if (state.facing === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      if (useFlash) overlay.classList.remove('fire');
      sound.shutter();
      vibrate(15);
      video.style.visibility = 'hidden';
      setTimeout(() => (video.style.visibility = ''), 90);

      const raw = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('Capture failed'))), 'image/jpeg', 0.92)
      );
      canvas.width = canvas.height = 0;
      const photo = { id: uid(), rollId: r.id, index: r.shots, raw, takenAt: Date.now(), facing: state.facing };
      r.shots += 1;
      r.needsWind = r.shots < r.size;
      await DB.putMany([['photos', photo], ['rolls', r]]);
      state.windProgress = 0;
      renderCamera();
    } catch (e) {
      console.error(e);
      overlay.classList.remove('fire');
      dialog('Shot not saved', 'Something went wrong saving that frame. It did not use up an exposure.', 'OK', null);
    } finally {
      state.busy = false;
    }
  }

  function setupWheel() {
    const wheel = $('#wheel');
    const ridges = $('#wheel-ridges');
    let active = false;
    let lastY = 0;
    let offset = 0;
    let lastTick = 0;

    wheel.addEventListener('pointerdown', (e) => {
      active = true;
      lastY = e.clientY;
      wheel.setPointerCapture(e.pointerId);
      ac();
    });

    wheel.addEventListener('pointermove', (e) => {
      if (!active) return;
      const dy = e.clientY - lastY;
      lastY = e.clientY;
      const r = state.roll;
      if (!r || !r.needsWind) {
        offset += dy * 0.15;
        ridges.style.backgroundPosition = `0 0, 0 0, 0 ${offset}px`;
        return;
      }
      if (dy <= 0) return;
      offset += dy;
      ridges.style.backgroundPosition = `0 0, 0 0, 0 ${offset}px`;
      state.windProgress += dy;
      if (state.windProgress - lastTick >= TICK_EVERY) {
        lastTick = state.windProgress;
        sound.tick();
        vibrate(6);
      }
      wheel.setAttribute('aria-valuenow', String(Math.min(100, Math.round((state.windProgress / WIND_DISTANCE) * 100))));
      if (state.windProgress >= WIND_DISTANCE) {
        active = false;
        lastTick = 0;
        completeWind();
      }
    });

    const end = () => { active = false; };
    wheel.addEventListener('pointerup', end);
    wheel.addEventListener('pointercancel', end);
  }

  async function completeWind() {
    const r = state.roll;
    if (!r) return;
    r.needsWind = false;
    state.windProgress = 0;
    sound.clunk();
    vibrate(35);
    await DB.put('rolls', r);
    renderCamera();
  }

  async function sendToLab() {
    const r = state.roll;
    if (!r) return;
    stopStream();
    if (r.shots === 0) {
      await DB.deleteRoll(r.id);
    } else {
      const now = Date.now();
      Object.assign(r, {
        status: 'lab',
        discarded: r.size - r.shots,
        sentAt: now,
        delay: state.settings.delay,
        readyAt: now + state.settings.delay,
        elapsed: 0,
        lastCheck: now,
        dateStamp: state.settings.dateStamp,
        needsWind: false
      });
      await DB.put('rolls', r);
    }
    state.roll = null;
    show('home');
    await refreshHome();
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
    show('roll');
  }

  function closeRoll() {
    if (state.view) state.view.prints.forEach((p) => URL.revokeObjectURL(p.url));
    state.view = null;
  }

  function openViewer(i) {
    if (!state.view || !state.view.prints.length) return;
    const n = state.view.prints.length;
    state.viewerIndex = (i + n) % n;
    const p = state.view.prints[state.viewerIndex];
    $('#viewer-img').src = p.url;
    $('#viewer-count').textContent = `${state.viewerIndex + 1} / ${n}`;
    $('#viewer').hidden = false;
  }

  function fileFor(p) {
    const d = new Date(state.view.roll.createdAt);
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return new File([p.blob], `rollcam-${stamp}-${String(p.index + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' });
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

  function setupViewer() {
    $('#btn-viewer-close').addEventListener('click', () => {
      $('#viewer').hidden = true;
      $('#viewer-img').removeAttribute('src');
    });
    $('#btn-viewer-save').addEventListener('click', () => {
      if (!state.view) return;
      saveFiles([fileFor(state.view.prints[state.viewerIndex])]);
    });
    const stage = $('#viewer-stage');
    const img = $('#viewer-img');
    let startX = null, startY = 0;
    stage.addEventListener('pointerdown', (e) => { startX = e.clientX; startY = e.clientY; });
    stage.addEventListener('pointermove', (e) => {
      if (startX === null) return;
      img.style.transform = `translateX(${(e.clientX - startX) * 0.6}px)`;
    });
    const finish = (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = null;
      img.style.transform = '';
      if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) openViewer(state.viewerIndex + (dx < 0 ? 1 : -1));
      else if (dy > 120) $('#btn-viewer-close').click();
    };
    stage.addEventListener('pointerup', finish);
    stage.addEventListener('pointercancel', () => { startX = null; img.style.transform = ''; });
    document.addEventListener('keydown', (e) => {
      if ($('#viewer').hidden) return;
      if (e.key === 'ArrowRight') openViewer(state.viewerIndex + 1);
      if (e.key === 'ArrowLeft') openViewer(state.viewerIndex - 1);
      if (e.key === 'Escape') $('#btn-viewer-close').click();
    });
  }

  async function loadSettings() {
    state.settings.delay = await DB.getMeta('delay', 86400000);
    state.settings.dateStamp = await DB.getMeta('dateStamp', true);
  }

  async function openSettings() {
    document.querySelectorAll('#seg-delay button').forEach((b) =>
      b.classList.toggle('on', Number(b.dataset.v) === state.settings.delay)
    );
    $('#opt-date').checked = state.settings.dateStamp;
    $('#storage-note').textContent = '';
    $('#sheet').hidden = false;
    try {
      const parts = [];
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate();
        parts.push(`Using ${(est.usage / 1048576).toFixed(1)} MB on this device.`);
      }
      if (navigator.storage && navigator.storage.persisted) {
        parts.push((await navigator.storage.persisted()) ? 'Storage is persistent.' : 'Storage may be cleared by the browser if space runs low.');
      }
      parts.push('Photos live only on this device — there is no cloud backup.');
      $('#storage-note').textContent = parts.join(' ');
    } catch (e) {}
  }

  function setupSettings() {
    $('#btn-settings').addEventListener('click', openSettings);
    $('#seg-delay').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      state.settings.delay = Number(b.dataset.v);
      DB.setMeta('delay', state.settings.delay);
      document.querySelectorAll('#seg-delay button').forEach((x) => x.classList.toggle('on', x === b));
    });
    $('#opt-date').addEventListener('change', (e) => {
      state.settings.dateStamp = e.target.checked;
      DB.setMeta('dateStamp', state.settings.dateStamp);
    });
    $('#btn-sheet-close').addEventListener('click', () => ($('#sheet').hidden = true));
    $('#sheet').addEventListener('click', (e) => {
      if (e.target.id === 'sheet') $('#sheet').hidden = true;
    });
  }

  function setupCamera() {
    $('#btn-shutter').addEventListener('click', shoot);
    $('#btn-flip').addEventListener('click', () => {
      state.facing = state.facing === 'user' ? 'environment' : 'user';
      renderCamera();
      if (state.roll && state.roll.shots < state.roll.size) startStream();
    });
    $('#btn-flash').addEventListener('click', () => {
      state.flash = !state.flash;
      renderCamera();
    });
    $('#btn-cam-back').addEventListener('click', () => {
      show('home');
      refreshHome();
    });
    $('#btn-send').addEventListener('click', sendToLab);
    $('#btn-early').addEventListener('click', developEarly);
    document.querySelector('.vf-bezel').addEventListener('click', () => {
      if (!state.stream && state.roll && state.roll.shots < state.roll.size) startStream();
    });
    setupWheel();
  }

  function setupRoll() {
    $('#btn-roll-back').addEventListener('click', () => {
      closeRoll();
      show('home');
      refreshHome();
    });
    $('#btn-save-all').addEventListener('click', () => {
      if (state.view) saveFiles(state.view.prints.map(fileFor));
    });
    $('#btn-delete-roll').addEventListener('click', async () => {
      if (!state.view) return;
      const ok = await dialog('Delete this roll?', 'These photos will be removed from Rollcam for good. Save any you want to keep first.', 'Delete', 'Cancel');
      if (!ok) return;
      await DB.deleteRoll(state.view.roll.id);
      closeRoll();
      show('home');
      refreshHome();
    });
  }

  function setupLifecycle() {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        persistLabClocks();
        stopStream();
      } else {
        if ($('#camera').classList.contains('active') && state.roll && state.roll.shots < state.roll.size) startStream();
        if ($('#home').classList.contains('active')) refreshHome();
      }
    });
    window.addEventListener('pagehide', () => {
      persistLabClocks();
      stopStream();
    });
  }

  async function init() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
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
      await refreshHome();
    } catch (e) {
      console.error(e);
      dialog('Storage unavailable', 'Rollcam couldn’t open its on-device storage. Private Browsing can block it — try a normal Safari tab or the home-screen app.', 'OK', null);
    }
    setInterval(tick, 1000);
  }

  init();
})();
