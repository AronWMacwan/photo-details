// Photo Details
// Flow: take a photo -> find coordinates -> look up the address -> show details -> watermark + download.
(() => {
  'use strict';

  // ---------- 1. Settings ----------

  const CONFIG = {
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/reverse',
    CONTACT_EMAIL: '',          // optional; Nominatim asks apps to give one
    CREDIT: '© OpenStreetMap contributors',
    ADDRESS_TIMEOUT_MS: 10000,
    LOCATION_TIMEOUT_MS: 15000,
    MIN_GAP_MS: 1100,           // Nominatim allows about 1 request per second
    LOCALE: undefined,          // e.g. 'en-IN'; undefined = browser default
    EXPORT_MAX_SIDE: 2000,      // longest side of the download, in pixels
    EXPORT_QUALITY: 0.92
  };

  // ---------- 2. Page elements and state ----------

  const $ = (id) => document.getElementById(id);

  const el = {
    banner: $('banner'), bannerText: $('bannerText'), video: $('video'), photo: $('photo'),
    placeholder: $('placeholder'), tag: $('stageTag'), take: $('takeBtn'), takeLabel: $('takeLabel'),
    camRow: $('camRow'), camSelect: $('camSelect'), hint: $('hint'),
    rows: $('rows'), file: $('fileInput'),
    exportBox: $('exportBox'), download: $('downloadBtn'), downloadLabel: $('downloadLabel'), exportMsg: $('exportMsg')
  };

  const state = {
    run: 0,          // goes up whenever something new starts; slow tasks compare it to spot outdated work
    stream: null,    // webcam stream while the preview runs
    photoUrl: null,  // URL of the ORIGINAL photo (never changed, so the watermark is never stamped twice)
    result: null,    // everything we know about the current photo
    exporting: false,
    export: null     // { url, filename } of the watermarked image
  };

  const isOutdated = (run) => run !== state.run;

  // Phones use the camera app; computers use the webcam.
  const isPhone = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPad pretending to be a Mac

  // ---------- 3. Small helpers ----------

  // kind: 'info' | 'ok' (green) | 'warn' (amber) | 'err' (red)
  function setStatus(message, kind = 'info') {
    el.bannerText.textContent = message;
    el.banner.className = 'banner ' + kind;
  }

  // mode: 'placeholder' | 'video' (live preview) | 'photo'
  function setStage(mode) {
    el.placeholder.hidden = mode !== 'placeholder';
    el.video.hidden = mode !== 'video';
    el.photo.hidden = mode !== 'photo';
    el.tag.hidden = mode === 'placeholder';
    el.tag.textContent = mode === 'video' ? 'Live preview' : 'Captured photo';
  }

  function setButton(label, outline = false) {
    el.takeLabel.textContent = label;
    el.take.className = 'btn ' + (outline ? 'outline' : 'primary');
  }

  function lockControls(locked) {
    el.take.disabled = locked;
    el.camSelect.disabled = locked;
  }

  const formatTime = (date) => new Intl.DateTimeFormat(CONFIG.LOCALE, { dateStyle: 'medium', timeStyle: 'long' }).format(date);

  function formatCoordinates({ lat, lng }) {
    const part = (value, positive, negative) => Math.abs(value).toFixed(4) + '° ' + (value >= 0 ? positive : negative);
    return part(lat, 'N', 'S') + ', ' + part(lng, 'E', 'W');
  }

  // ---------- 4. Getting a photo ----------

  // Phone: the browser opens its camera and hands us a file.
  function onFileChosen() {
    const file = el.file.files && el.file.files[0];
    el.file.value = ''; // lets the same file be chosen again
    if (file) processPhoto(file, true, new Date()); // no file = the user cancelled: do nothing
  }

  function cameraError(error) {
    if (!window.isSecureContext) return 'Camera access needs HTTPS or localhost.';
    const messages = {
      NotAllowedError: 'Camera access was denied. Allow access in your browser settings.',
      SecurityError: 'Camera access is blocked by browser security settings.',
      NotFoundError: 'No suitable camera was found.',
      OverconstrainedError: 'The selected camera is unavailable.',
      NotReadableError: 'The camera could not be read. It may be in use by another app.'
    };
    return messages[error && error.name] || 'The camera could not be started.';
  }

  function stopCamera() {
    if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
    el.video.srcObject = null;
    el.camRow.hidden = true;
    lockControls(false);
  }

  // Fill the camera dropdown (shown only when there are 2 or more cameras).
  async function listCameras(activeId, run) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (isOutdated(run)) return;

      const cameras = devices.filter((device) => device.kind === 'videoinput');
      el.camSelect.replaceChildren(...cameras.map((c, i) => new Option(c.label || 'Camera ' + (i + 1), c.deviceId)));
      if (activeId) el.camSelect.value = activeId;
      el.camRow.hidden = cameras.length < 2;
    } catch (error) {
      el.camRow.hidden = true;
    }
  }

  // Computer: start the webcam preview.
  async function startPreview(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus(window.isSecureContext ? 'This browser does not support camera access.' : cameraError(), 'err');
      return;
    }

    const run = ++state.run;
    stopCamera();
    clearResult();
    lockControls(true);
    setStatus('Starting camera…');

    try {
      const video = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: 'user' };

      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      if (isOutdated(run)) { // the user did something else meanwhile: release this camera
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      state.stream = stream;
      el.video.srcObject = stream;
      await el.video.play();
      if (isOutdated(run)) return;

      lockControls(false);
      setStage('video');
      setButton('Capture Photo');
      setStatus('Camera ready. Press Capture Photo.');
      listCameras(stream.getVideoTracks()[0].getSettings().deviceId, run);
    } catch (error) {
      if (isOutdated(run)) return;
      stopCamera();
      setStage('placeholder');
      setButton('Take Photo');
      setStatus(cameraError(error), 'err');
    }
  }

  // Computer: copy the current video frame onto a canvas and encode it as a JPEG.
  function captureStill() {
    if (!el.video.videoWidth) return;

    lockControls(true); // no repeat clicks while encoding
    const run = state.run;
    const takenAt = new Date();

    const canvas = document.createElement('canvas');
    canvas.width = el.video.videoWidth;
    canvas.height = el.video.videoHeight;
    canvas.getContext('2d').drawImage(el.video, 0, 0);

    canvas.toBlob((blob) => {
      if (isOutdated(run)) return;
      stopCamera();

      if (blob) {
        processPhoto(blob, false, takenAt);
      } else {
        setStage('placeholder');
        setButton('Take Photo');
        setStatus('The photo could not be captured. Try again.', 'err');
      }
    }, 'image/jpeg', 0.92);
  }

  // ---------- 5. Finding coordinates ----------

  const validCoords = (lat, lng) =>
    Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

  // GPS stored inside the photo file (EXIF). Many photos have none.
  async function readPhotoGps(blob) {
    try {
      const gps = window.exifr && await window.exifr.gps(blob);
      return gps && validCoords(gps.latitude, gps.longitude) ? { lat: gps.latitude, lng: gps.longitude } : null;
    } catch (error) {
      return null;
    }
  }

  // The device's location according to the browser (GPS, Wi-Fi or network).
  function readDeviceLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation || !window.isSecureContext) {
        reject(new Error('Location needs a supporting browser and HTTPS or localhost.'));
        return;
      }

      const onSuccess = (position) => {
        const { latitude: lat, longitude: lng } = position.coords;
        if (!validCoords(lat, lng)) {
          reject(new Error('The browser returned invalid coordinates.'));
          return;
        }
        resolve({ lat, lng });
      };

      const onError = (error) => {
        const messages = { 1: 'Location permission was denied.', 2: 'Location is unavailable right now.', 3: 'The location request timed out.' };
        reject(new Error(messages[error.code] || 'Location could not be retrieved.'));
      };

      navigator.geolocation.getCurrentPosition(onSuccess, onError, {
        enableHighAccuracy: true, timeout: CONFIG.LOCATION_TIMEOUT_MS, maximumAge: 0 // fresh reading
      });
    });
  }

  // The photo's own GPS wins; otherwise the browser location.
  function chooseCoordinates(result) {
    if (result.photoGps) return { ...result.photoGps, source: 'photo' };
    if (result.device) return { lat: result.device.lat, lng: result.device.lng, source: 'device' };
    return null;
  }

  // ---------- 6. Finding the address (OpenStreetMap Nominatim) ----------

  const addressCache = new Map(); // same place again = no new request
  let nextLookupAt = 0;           // we must not send another request before this time

  // status: resolved (complete) | partial (something missing) | unavailable (nothing found)
  function readAddress(data) {
    if (!data || data.error || !data.address) return { status: 'unavailable' };

    const a = data.address;
    const found = {
      street: a.road || a.pedestrian || a.footway,
      'house/building details': a.house_number || a.house_name || a.building,
      city: a.city || a.town || a.village || a.municipality
    };
    const missing = Object.keys(found).filter((name) => !found[name]);

    return { status: missing.length ? 'partial' : 'resolved', formatted: data.display_name, missing };
  }

  // Always returns an object with a status: resolved | partial | unavailable | failed | cancelled
  async function getAddress(lat, lng, run) {
    if (!navigator.onLine) return { status: 'failed', message: 'You appear to be offline.' };

    const key = lat.toFixed(5) + ',' + lng.toFixed(5);
    if (addressCache.has(key)) return addressCache.get(key);

    // Wait our turn so requests stay at least MIN_GAP_MS apart.
    const wait = Math.max(0, nextLookupAt - Date.now());
    nextLookupAt = Date.now() + wait + CONFIG.MIN_GAP_MS;
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    if (isOutdated(run)) return { status: 'cancelled' }; // a newer photo exists: skip the request

    const query = new URLSearchParams({ format: 'jsonv2', lat, lon: lng, zoom: 18, addressdetails: 1, 'accept-language': 'en' });
    if (CONFIG.CONTACT_EMAIL) query.set('email', CONFIG.CONTACT_EMAIL);

    // The timer also covers reading the reply, not just the connection.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.ADDRESS_TIMEOUT_MS);

    try {
      const response = await fetch(CONFIG.NOMINATIM_URL + '?' + query, { signal: controller.signal });
      if (response.status === 429) return { status: 'failed', message: 'Address service is busy. Try again in a moment.' };
      if (!response.ok) throw new Error('HTTP ' + response.status);

      const result = readAddress(await response.json());
      addressCache.set(key, result);
      return result;
    } catch (error) {
      const timedOut = error.name === 'AbortError';
      return { status: 'failed', message: timedOut ? 'Address lookup timed out.' : 'Address lookup failed (network or service error).' };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- 7. Main flow ----------

  function clearResult() {
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl);
    if (state.export) URL.revokeObjectURL(state.export.url);

    Object.assign(state, { photoUrl: null, result: null, export: null, exporting: false });
    el.photo.removeAttribute('src');
    el.exportBox.hidden = true;
    showExportMessage('');
    render();
  }

  async function processPhoto(blob, fromFile, time) {
    const run = ++state.run;
    stopCamera();
    clearResult();

    state.photoUrl = URL.createObjectURL(blob);
    el.photo.src = state.photoUrl; // the original shows first; the watermarked copy replaces it later
    setStage('photo');

    const result = state.result = { fromFile, time, photoGps: null, device: null, locationError: null, address: null, step: 'location' };

    el.exportBox.hidden = false;
    showExportMessage('Download is available once location and address lookup finish.');
    updateDownload();
    setButton('Take Another Photo', true);
    setStatus('Reading photo location…');
    render();

    // Step 1: coordinates (photo GPS and browser location are read at the same time).
    const [gps, device] = await Promise.allSettled([fromFile ? readPhotoGps(blob) : null, readDeviceLocation()]);
    if (isOutdated(run)) return;

    if (gps.status === 'fulfilled') result.photoGps = gps.value;
    if (device.status === 'fulfilled') result.device = device.value;
    else result.locationError = device.reason.message;

    // Step 2: address.
    const coords = chooseCoordinates(result);
    if (coords) {
      result.step = 'address';
      render();
      setStatus('Resolving address…');

      result.address = await getAddress(coords.lat, coords.lng, run);
      if (isOutdated(run) || result.address.status === 'cancelled') return;
    }

    result.step = 'done';
    render();
    if (coords) setStatus('Done. Details are shown below.', 'ok');
    else setStatus(result.locationError || 'No location is available.', 'warn');

    generateExport();
  }

  // ---------- 8. Details panel ----------

  // One row. A note is 'text' or ['text', 'cssClass'].
  function row(label, value, notes = [], pending = false) {
    const wrapper = document.createElement('div');
    wrapper.className = 'row';

    const title = document.createElement('dt');
    title.textContent = label;

    const content = document.createElement('dd');
    const main = document.createElement('span');
    main.textContent = value;
    if (pending) main.className = 'pending';
    content.append(main);

    for (const note of notes.filter(Boolean)) {
      const [text, cssClass] = [].concat(note);
      const line = document.createElement('span');
      line.className = cssClass || 'sub2';
      line.textContent = text;
      content.append(line);
    }

    wrapper.append(title, content);
    return wrapper;
  }

  function locationNote(result) {
    const coords = chooseCoordinates(result);
    if (coords && coords.source === 'photo') return 'Location taken from the photo’s embedded GPS.';
    return 'Device location sampled after the ' + (result.fromFile ? 'photo returned.' : 'frame was captured.');
  }

  function addressRow(result) {
    const address = result.address;

    if (result.step === 'address') return row('Address', 'Resolving…', [], true);
    if (!address) return row('Address', result.step === 'done' ? 'Unavailable (no coordinates)' : '—');
    if (address.status === 'failed') return row('Address', 'Lookup failed', [[address.message, 'failed']]);
    if (address.status === 'unavailable') return row('Address', 'No address found');

    const partial = address.status === 'partial' ? [['Partial address — missing: ' + address.missing.join(', ') + '.', 'partial']] : [];
    return row('Address', address.formatted || '—', [...partial, 'Address data: OpenStreetMap Nominatim · ' + CONFIG.CREDIT]);
  }

  // Redraws the details panel (time, coordinates, address) from state.result.
  function render() {
    const result = state.result;

    if (!result) {
      el.rows.replaceChildren(...['Photo received time', 'Coordinates', 'Address'].map((label) => row(label, '—')));
      return;
    }

    const coords = chooseCoordinates(result);
    const pending = result.step === 'location';

    el.rows.replaceChildren(
      row(result.fromFile ? 'Photo received time' : 'Photo captured time', formatTime(result.time)),
      row('Coordinates', coords ? formatCoordinates(coords) : pending ? 'Reading…' : 'Unavailable',
        [coords ? locationNote(result) : result.locationError], pending),
      addressRow(result)
    );
  }

  // ---------- 9. Watermarked photo (preview + download) ----------

  const font = (bold, size) => (bold ? 'bold ' : '') + size + 'px "Segoe UI", Roboto, Arial, sans-serif';

  // The watermark shows only the address and the date/time (plus the credit OpenStreetMap requires).
  function watermarkLines(result) {
    const address = result.address;
    const hasAddress = Boolean(address && address.formatted && (address.status === 'resolved' || address.status === 'partial'));
    const details = [(result.fromFile ? 'Received: ' : 'Browser capture: ') + formatTime(result.time)];

    if (address && address.status === 'failed') details.unshift(address.message);
    else if (address && !hasAddress) details.unshift('No address found for these coordinates');
    if (hasAddress) details.push(CONFIG.CREDIT);

    return { heading: hasAddress ? address.formatted : 'Address unavailable', details };
  }

  // Splits text into lines that fit (the first line may be shorter). limits must be above 0.
  function wrapText(ctx, text, firstWidth, fullWidth) {
    const lines = [];
    let line = '';
    let limit = firstWidth;
    const fits = (s) => ctx.measureText(s).width <= limit;

    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const attempt = line ? line + ' ' + word : word;
      if (fits(attempt)) { line = attempt; continue; }

      if (line) { lines.push(line); line = ''; limit = fullWidth; }

      let rest = word; // a word wider than the line is cut into pieces
      while (!fits(rest)) {
        let cut = Math.max(1, rest.length - 1);
        while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
        limit = fullWidth;
      }
      line = rest;
    }

    lines.push(line);
    return lines;
  }

  // Lays out the watermark in the bottom-right corner. The text size comes from the photo size, and
  // padding, margin and corners scale with it. If the panel is taller than the photo, the text shrinks.
  function layoutWatermark(ctx, lines, width, height) {
    const measure = (size) => {
      const headSize = Math.round(size * 1.25);
      const pad = Math.round(size * 0.8);
      const margin = size;
      const pin = Math.round(headSize * 1.1);   // pin icon size
      const pinGap = Math.round(size * 0.4);
      const maxPanel = Math.min(width - margin * 2, Math.round(width * 0.8));
      const maxText = Math.max(20, maxPanel - pad * 2);

      const rows = []; // each row = one line of text and its distance from the top of the panel
      let y = pad;
      let widest = 0;

      ctx.font = font(true, headSize);
      wrapText(ctx, lines.heading, Math.max(20, maxText - pin - pinGap), maxText).forEach((text, i) => {
        widest = Math.max(widest, ctx.measureText(text).width + (i === 0 ? pin + pinGap : 0));
        rows.push({ text, bold: true, size: headSize, y, pin: i === 0 });
        y += Math.round(headSize * 1.3);
      });
      y += Math.round(size * 0.2);

      ctx.font = font(false, size);
      for (const line of lines.details) {
        for (const text of wrapText(ctx, line, maxText, maxText)) {
          widest = Math.max(widest, ctx.measureText(text).width);
          rows.push({ text, bold: false, size, y, pin: false });
          y += Math.round(size * 1.35);
        }
      }

      return {
        rows, pad, margin, pin, pinGap, radius: Math.round(size * 0.7),
        width: Math.min(maxPanel, Math.ceil(widest) + pad * 2),
        height: y - Math.round(size * 0.35) + pad
      };
    };

    let size = Math.max(12, Math.round(Math.min(width, height) * 0.025));
    let layout = measure(size);
    while (size > 8 && layout.height > height - layout.margin * 2) {
      size = Math.max(8, Math.floor(size * 0.85));
      layout = measure(size);
    }

    layout.x = width - layout.margin - layout.width;
    layout.y = Math.max(0, height - layout.margin - layout.height);
    return layout;
  }

  // A small red location pin: round head, pointed tip, white dot.
  function drawPin(ctx, centerX, top, size) {
    const radius = size * 0.34;
    const centerY = top + radius;

    ctx.fillStyle = '#e53935';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI * 0.8, Math.PI * 0.2);
    ctx.lineTo(centerX, top + size);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draws the dark rounded panel, then the right-aligned white text and the pin.
  function drawWatermark(ctx, layout) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(layout.x, layout.y, layout.width, layout.height, layout.radius);
    else ctx.rect(layout.x, layout.y, layout.width, layout.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.fill();

    const right = layout.x + layout.width - layout.pad;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';

    for (const line of layout.rows) {
      ctx.font = font(line.bold, line.size);
      ctx.fillStyle = '#fff';
      ctx.fillText(line.text, right, layout.y + line.y);

      if (line.pin) {
        const textLeft = right - ctx.measureText(line.text).width;
        const pinTop = layout.y + line.y + Math.round((line.size - layout.pin) / 2);
        drawPin(ctx, textLeft - layout.pinGap - layout.pin / 2, pinTop, layout.pin);
      }
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The photo could not be loaded.'));
      image.src = url;
    });
  }

  // Original photo + watermark -> JPEG. Same shape as the photo (no extra space, no cropping),
  // longest side at most EXPORT_MAX_SIDE.
  async function createWatermarkedImage(result, photoUrl) {
    const image = await loadImage(photoUrl);
    if (!image.naturalWidth) throw new Error('The photo could not be read.');

    const scale = Math.min(1, CONFIG.EXPORT_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot create the image.');

    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    drawWatermark(ctx, layoutWatermark(ctx, watermarkLines(result), canvas.width, canvas.height));

    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The image could not be created.'))), 'image/jpeg', CONFIG.EXPORT_QUALITY);
    });
  }

  function showExportMessage(text, isError = false) {
    el.exportMsg.textContent = text;
    el.exportMsg.className = 'export-msg' + (isError ? ' err' : '');
  }

  // The button works only when processing is finished and no image is being created.
  function updateDownload() {
    const ready = Boolean(state.result) && state.result.step === 'done';
    el.download.disabled = !ready || state.exporting;
    el.downloadLabel.textContent = state.exporting ? 'Preparing image…' : 'Download Photo with Details';
  }

  // Creates the watermarked image and shows it in the photo preview.
  async function generateExport() {
    const result = state.result;
    if (state.exporting || !result || result.step !== 'done') return;

    state.exporting = true;
    updateDownload();
    showExportMessage('Preparing image…');

    try {
      const blob = await createWatermarkedImage(result, state.photoUrl);
      if (state.result !== result) return; // a newer photo replaced this one: drop the image

      const now = new Date();
      const stamp = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace(/\D/g, ''); // local time, YYYYMMDDHHMMSS

      state.export = { url: URL.createObjectURL(blob), filename: 'photo-details-' + stamp + '.jpg' };
      el.photo.src = state.export.url; // the preview now shows the watermarked photo
      showExportMessage('');
    } catch (error) {
      if (state.result === result) showExportMessage((error.message || 'The image could not be created.') + ' Press the button to try again.', true);
    } finally {
      if (state.result === result) {
        state.exporting = false;
        updateDownload();
      }
    }
  }

  // Downloads the same image that the preview shows.
  async function onDownloadClick() {
    const result = state.result;
    if (!result || state.exporting) return;

    if (!state.export) await generateExport(); // e.g. retry after an earlier error
    if (state.result !== result || !state.export) return;

    const link = document.createElement('a');
    link.href = state.export.url;
    link.download = state.export.filename;
    document.body.append(link);
    link.click();
    link.remove();
  }

  // ---------- 10. Start up ----------

  function init() {
    render();

    el.hint.textContent = isPhone
      ? 'Opens your phone camera where supported. Some browsers may show other options.'
      : 'Uses your webcam.';

    el.take.addEventListener('click', () => {
      if (state.stream) captureStill();   // webcam running: take the picture
      else if (isPhone) el.file.click();  // phone: open the camera app
      else startPreview();                // computer: start the webcam
    });
    el.camSelect.addEventListener('change', () => startPreview(el.camSelect.value));
    el.file.addEventListener('change', onFileChosen);
    el.download.addEventListener('click', onDownloadClick);

    // Turn the webcam off when the user leaves the tab or the page.
    const stopWhenHidden = () => {
      if (!state.stream) return;
      state.run++;
      stopCamera();
      setStage('placeholder');
      setButton('Take Photo');
      setStatus('Camera stopped because the tab was hidden.');
    };
    document.addEventListener('visibilitychange', () => { if (document.hidden) stopWhenHidden(); });
    window.addEventListener('pagehide', stopWhenHidden);

    if (!window.isSecureContext) setStatus('Camera and location need HTTPS or localhost.', 'warn');
  }

  init();
})();
