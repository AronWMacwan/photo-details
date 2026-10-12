(() => {
  'use strict';


  // 1. SETTINGS


  const CONFIG = {
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/reverse',
    CONTACT_EMAIL: '',            // optional, recommended by Nominatim
    CREDIT: '© OpenStreetMap contributors',
    ADDRESS_TIMEOUT_MS: 10000,    // give up on the address lookup after 10 s
    LOCATION_TIMEOUT_MS: 15000,   // give up on the browser location after 15 s
    MIN_GAP_BETWEEN_LOOKUPS_MS: 1100, // Nominatim allows about 1 request per second
    LOCALE: undefined,            // e.g. 'en-IN'; undefined = browser default
    EXPORT_MAX_SIDE: 2000,        // longest side of the downloaded photo, in pixels
    EXPORT_QUALITY: 0.92          // JPEG quality of the download
  };


  // 2. PAGE ELEMENTS AND APP STATE


  const $ = (id) => document.getElementById(id);

  const el = {
    banner: $('banner'),
    bannerText: $('bannerText'),
    video: $('video'),
    photo: $('photo'),
    placeholder: $('placeholder'),
    tag: $('stageTag'),
    take: $('takeBtn'),
    takeLabel: $('takeLabel'),
    camRow: $('camRow'),
    camSelect: $('camSelect'),
    hint: $('hint'),
    webcamLink: $('webcamLink'),
    rows: $('rows'),
    note: $('note'),
    file: $('fileInput'),
    exportBox: $('exportBox'),
    download: $('downloadBtn'),
    downloadLabel: $('downloadLabel'),
    exportMsg: $('exportMsg')
  };

  const state = {
    run: 0,          // goes up every time something new starts (see isOutdated)
    stream: null,    // the webcam stream, while the preview is running
    photoUrl: null,  // temporary URL of the photo shown on the page
    previewing: false,
    busy: false,
    result: null,    // everything we know about the current photo
    exporting: false, // true while the combined image is being created
    export: null     // { blob, url, filename } of the watermarked image, once created
  };

  // Slow tasks (camera start, location, address) finish later.
  // If the user has started something new in the meantime, their result is outdated: ignore it.
  //   const run = ++state.run;   ...await something...   if (isOutdated(run)) return;
  function isOutdated(run) {
    return run !== state.run;
  }

  // A guess: phones use the camera app, computers use the webcam.
  function detectPhone() {
    const mobileFlag = navigator.userAgentData && navigator.userAgentData.mobile;
    if (typeof mobileFlag === 'boolean') return mobileFlag;

    const looksMobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const isIpadAsMac = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    return looksMobile || isIpadAsMac;
  }
  const isPhone = detectPhone();


  // 3. SMALL HELPERS (show messages, format text)


  // kind: 'info' (blue), 'ok' (green), 'warn' (amber), 'err' (red)
  function setStatus(message, kind = 'info') {
    el.bannerText.textContent = message;
    el.banner.className = 'banner ' + kind;
  }

  // mode: 'placeholder' (empty picture), 'video' (live preview), 'photo' (captured photo)
  function setStage(mode) {
    el.placeholder.hidden = mode !== 'placeholder';
    el.video.hidden = mode !== 'video';
    el.photo.hidden = mode !== 'photo';

    el.tag.hidden = mode === 'placeholder';
    el.tag.textContent = mode === 'video' ? 'Live preview' : 'Captured photo';
  }

  function setButton(label, isOutline = false) {
    el.takeLabel.textContent = label;
    el.take.className = 'btn ' + (isOutline ? 'outline' : 'primary');
  }

  // While busy, the user cannot click the button or change camera.
  function setBusy(busy) {
    state.busy = busy;
    el.take.disabled = busy;
    el.camSelect.disabled = busy;
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat(CONFIG.LOCALE, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    }).format(date);
  }

  function formatAccuracy(accuracy) {
    if (accuracy == null) return 'Accuracy not reported';
    return '±' + Math.round(accuracy) + ' m';
  }

  function formatCoordinates(coords) {
    const lat = Math.abs(coords.lat).toFixed(4) + '° ' + (coords.lat >= 0 ? 'N' : 'S');
    const lng = Math.abs(coords.lng).toFixed(4) + '° ' + (coords.lng >= 0 ? 'E' : 'W');
    return lat + ', ' + lng;
  }


  // 4. GETTING A PHOTO


  // 4a. Phone: the browser opens its camera and gives us a file

  function onFileChosen() {
    const file = el.file.files && el.file.files[0];

    el.file.value = ''; // lets the user pick the same file again later

    if (!file) return; // user cancelled the camera: do nothing

    processPhoto(file, { fromFile: true, time: new Date() });
  }

  // 4b. Computer: webcam preview, then capture a still frame

  function cameraErrorMessage(error) {
    if (!window.isSecureContext) return 'Camera access needs HTTPS or localhost.';

    const messages = {
      NotAllowedError: 'Camera access was denied. Allow access in your browser settings.',
      SecurityError: 'Camera access is blocked by browser security settings.',
      NotFoundError: 'No suitable camera was found.',
      OverconstrainedError: 'The selected camera or camera settings are unavailable.',
      NotReadableError: 'The camera could not be read. It may be in use by another app.'
    };
    return messages[error && error.name] || 'The camera could not be started.';
  }

  function stopCamera() {
    if (state.stream) {
      state.stream.getTracks().forEach((track) => track.stop());
    }
    state.stream = null;
    state.previewing = false;

    el.video.srcObject = null;
    el.camRow.hidden = true;
    setBusy(false);
  }

  // Fill the "choose camera" dropdown (only shown when there are 2+ cameras).
  async function listCameras(activeId, run) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      if (isOutdated(run)) return;

      const cameras = devices.filter((device) => device.kind === 'videoinput');

      el.camSelect.replaceChildren(
        ...cameras.map((camera, i) => new Option(camera.label || 'Camera ' + (i + 1), camera.deviceId))
      );
      if (activeId) el.camSelect.value = activeId;

      el.camRow.hidden = cameras.length < 2;
    } catch (error) {
      el.camRow.hidden = true;
    }
  }

  async function startPreview(deviceId) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const message = window.isSecureContext
        ? 'This browser does not support camera access.'
        : cameraErrorMessage();
      setStatus(message, 'err');
      return;
    }

    const run = ++state.run;
    stopCamera();
    clearResult();

    setBusy(true);
    setStatus('Starting camera…');

    try {
      // Use the chosen camera, otherwise prefer the back camera on phones and the front one on computers.
      const video = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: { ideal: isPhone ? 'environment' : 'user' } };

      const stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });

      // The user did something else while we waited: release this camera.
      if (isOutdated(run)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      state.stream = stream;
      el.video.srcObject = stream;
      await el.video.play();
      if (isOutdated(run)) return;

      state.previewing = true;
      setBusy(false);
      setStage('video');
      setButton('Capture Photo');
      setStatus('Camera ready. Press Capture Photo.');

      listCameras(stream.getVideoTracks()[0].getSettings().deviceId, run);
    } 
    catch (error) {
      if (isOutdated(run)) return;
      stopCamera();
      setStage('placeholder');
      setButton('Take Photo');
      setStatus(cameraErrorMessage(error), 'err');
    }
  }

  function showCaptureError() {
    setStage('placeholder');
    setButton('Take Photo');
    setStatus('The photo could not be captured. Try again.', 'err');
  }

  // Copy the current video frame onto a canvas and turn it into a JPEG.
  function captureStill() {
    if (state.busy || !el.video.videoWidth) return;

    setBusy(true); // stops repeated clicks while the image is being encoded
    const run = state.run;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = el.video.videoWidth;
      canvas.height = el.video.videoHeight;
      canvas.getContext('2d').drawImage(el.video, 0, 0);

      const takenAt = new Date();

      canvas.toBlob((blob) => {
        if (isOutdated(run)) return;

        stopCamera();
        if (!blob) {
          showCaptureError();
          return;
        }
        processPhoto(blob, { fromFile: false, time: takenAt });
      }, 'image/jpeg', 0.92);
    } catch (error) {
      stopCamera();
      showCaptureError();
    }
  }


  // 5. FINDING COORDINATES


  function isValidCoordinates(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
           Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  }

  // GPS stored inside the photo file (EXIF). Many photos have none.
  async function readPhotoGps(blob) {
    if (!window.exifr || !window.exifr.gps) return null;

    try {
      const gps = await window.exifr.gps(blob);
      if (!gps || !isValidCoordinates(gps.latitude, gps.longitude)) return null;
      return { lat: gps.latitude, lng: gps.longitude };
    } catch (error) {
      return null;
    }
  }

  // The device's location according to the browser (GPS, Wi-Fi or network).
  function readDeviceLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Location is not supported by this browser.'));
        return;
      }
      if (!window.isSecureContext) {
        reject(new Error('Location needs HTTPS or localhost.'));
        return;
      }

      const onSuccess = (position) => {
        const { latitude, longitude, accuracy } = position.coords;

        if (!isValidCoordinates(latitude, longitude)) {
          reject(new Error('The browser returned invalid coordinates.'));
          return;
        }
        resolve({
          lat: latitude,
          lng: longitude,
          accuracy: Number.isFinite(accuracy) ? accuracy : null,
          time: new Date(position.timestamp || Date.now())
        });
      };

      const onError = (error) => {
        const messages = {
          1: 'Location permission was denied.',
          2: 'Location is unavailable right now.',
          3: 'The location request timed out.'
        };
        reject(new Error(messages[error.code] || 'Location could not be retrieved.'));
      };

      navigator.geolocation.getCurrentPosition(onSuccess, onError, {
        enableHighAccuracy: true,
        timeout: CONFIG.LOCATION_TIMEOUT_MS,
        maximumAge: 0 // always ask for a fresh reading
      });
    });
  }

  // Which coordinates do we use? The photo's own GPS wins, then the browser location.
  function chooseCoordinates(result) {
    if (result.photoGps) {
      return { lat: result.photoGps.lat, lng: result.photoGps.lng, source: 'photo' };
    }
    if (result.deviceLocation) {
      return { lat: result.deviceLocation.lat, lng: result.deviceLocation.lng, source: 'device' };
    }
    return null;
  }


  // 6. FINDING THE ADDRESS (OpenStreetMap Nominatim)


  const addressCache = new Map(); // same place again = no new request
  let nextLookupAllowedAt = 0;    // time before which we must not send another request

  // Pick the useful parts out of Nominatim's reply and say what is missing.
  function readAddress(data) {
    if (!data || data.error || !data.address) return { status: 'unavailable' };

    const a = data.address;

    const parts = {
      building: [a.house_number, a.house_name || a.building].filter(Boolean).join(' ') || null,
      street: a.road || a.pedestrian || a.footway || null,
      locality: a.neighbourhood || a.suburb || a.city_district || null,
      city: a.city || a.town || a.village || a.municipality || null,
      district: a.state_district || a.county || null,
      state: a.state || null,
      postal: a.postcode || null,
      country: a.country || null
    };

    const missing = [];
    if (!parts.street) missing.push('street');
    if (!parts.building) missing.push('house/building details');
    if (!parts.city) missing.push('city');

    return {
      status: missing.length > 0 ? 'partial' : 'resolved',
      formatted: data.display_name,
      parts: parts,
      missing: missing
    };
  }

  function addressErrorMessage(error) {
    if (error.message === 'RATE_LIMIT') return 'Address service is busy. Try again in a moment.';
    if (error.name === 'AbortError') return 'Address lookup timed out.';
    return 'Address lookup failed because of a network or service error.';
  }

  // Wait if the last lookup was less than ~1 second ago (Nominatim's rule).
  async function waitForTurn() {
    const waitMs = Math.max(0, nextLookupAllowedAt - Date.now());
    nextLookupAllowedAt = Date.now() + waitMs + CONFIG.MIN_GAP_BETWEEN_LOOKUPS_MS;

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  // Always returns an object with a "status":
  //   resolved | partial | unavailable | failed | cancelled
  async function getAddress(lat, lng, run) {
    if (!navigator.onLine) {
      return { status: 'failed', message: 'You appear to be offline.' };
    }

    const cacheKey = lat.toFixed(5) + ',' + lng.toFixed(5);
    if (addressCache.has(cacheKey)) return addressCache.get(cacheKey);

    await waitForTurn();
    if (isOutdated(run)) return { status: 'cancelled' }; // a newer photo exists: skip the request

    const query = new URLSearchParams({
      format: 'jsonv2',
      lat: lat,
      lon: lng,
      zoom: 18,
      addressdetails: 1,
      'accept-language': 'en'
    });
    if (CONFIG.CONTACT_EMAIL) query.set('email', CONFIG.CONTACT_EMAIL);

    // The timer cancels the request if the whole thing (including reading the reply) takes too long.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.ADDRESS_TIMEOUT_MS);

    try {
      const response = await fetch(CONFIG.NOMINATIM_URL + '?' + query, {
        signal: controller.signal,
        headers: { Accept: 'application/json' }
      });

      if (response.status === 429) throw new Error('RATE_LIMIT');
      if (!response.ok) throw new Error('HTTP_' + response.status);

      const result = readAddress(await response.json());
      addressCache.set(cacheKey, result);
      return result;
    } catch (error) {
      return { status: 'failed', message: addressErrorMessage(error) };
    } finally {
      clearTimeout(timer);
    }
  }


  // 7. MAIN FLOW: what happens after we have a photo


  function clearResult() {
    if (state.photoUrl) URL.revokeObjectURL(state.photoUrl); // free the memory

    state.photoUrl = null;
    state.result = null;
    el.photo.removeAttribute('src');
    clearExport();
    render();
  }

  async function processPhoto(blob, info) {
    const run = ++state.run;
    stopCamera();
    clearResult();

    // Show the photo straight away.
    state.photoUrl = URL.createObjectURL(blob);
    el.photo.src = state.photoUrl;
    setStage('photo');

    // Everything we learn about this photo is collected here.
    const result = {
      fromFile: info.fromFile,   // true = phone camera file, false = webcam frame
      receivedAt: info.time,
      photoGps: null,            // coordinates inside the photo (if any)
      deviceLocation: null,      // the browser's location reading (if any)
      locationError: null,
      address: null,
      step: 'location'           // 'location' -> 'address' -> 'done'
    };
    state.result = result;

    // The download stays disabled until location and address are finished.
    el.exportBox.hidden = false;
    setExportMessage('Download is available once location and address lookup finish.');
    updateExportControls();

    setButton('Take Another Photo', true);
    el.take.disabled = true;
    setStatus('Reading photo location…');
    render();

    // Step 1: look for coordinates (both searches run at the same time).
    const [gpsOutcome, deviceOutcome] = await Promise.allSettled([
      info.fromFile ? readPhotoGps(blob) : null,
      readDeviceLocation()
    ]);
    if (isOutdated(run)) return;

    if (gpsOutcome.status === 'fulfilled') result.photoGps = gpsOutcome.value;

    if (deviceOutcome.status === 'fulfilled') {
      result.deviceLocation = deviceOutcome.value;
    } else {
      result.locationError = deviceOutcome.reason.message;
    }

    const coords = chooseCoordinates(result);
    result.step = coords ? 'address' : 'done';
    el.take.disabled = false;
    render();

    if (!coords) {
      setStatus(result.locationError || 'No location is available.', 'warn');
      onProcessingFinished();
      return;
    }

    // Step 2: turn the coordinates into an address.
    setStatus('Resolving address…');
    const address = await getAddress(coords.lat, coords.lng, run);
    if (isOutdated(run) || address.status === 'cancelled') return;

    result.address = address;
    result.step = 'done';
    render();
    setStatus('Done. Details are shown below.', 'ok');
    onProcessingFinished();
  }


  // 8. SHOWING THE RESULTS


  const DASH = '—';

  const EMPTY_LABELS = [
    'Photo received time',
    'Location reading time',
    'Coordinates',
    'Reported accuracy',
    'Address'
  ];

  const ADDRESS_PART_LABELS = {
    building: 'Building',
    street: 'Street',
    locality: 'Area',
    city: 'City',
    district: 'District',
    state: 'State',
    postal: 'PIN',
    country: 'Country'
  };

  // Builds one row of the details panel.
  //   notes: small grey lines under the value. A note is a text string,
  //          or { text, cls } when it needs a colour class (e.g. 'partial', 'failed').
  function makeRow(label, value, notes = [], isPending = false) {
    const row = document.createElement('div');
    row.className = 'row';

    const title = document.createElement('dt');
    title.textContent = label;

    const content = document.createElement('dd');

    const main = document.createElement('span');
    main.textContent = value;
    if (isPending) main.className = 'pending';
    content.append(main);

    for (const note of notes) {
      if (!note) continue; // skip empty notes

      const line = document.createElement('span');
      line.className = note.cls || 'sub2';
      line.textContent = note.text || note;
      content.append(line);
    }

    row.append(title, content);
    return row;
  }

  function locationNote(result) {
    const coords = chooseCoordinates(result);

    if (coords && coords.source === 'photo') {
      return 'Location taken from the photo’s embedded GPS.';
    }
    return result.fromFile
      ? 'Device location sampled after the photo returned.'
      : 'Device location sampled after the frame was captured.';
  }

  function timeRow(result) {
    const label = result.fromFile ? 'Photo received time' : 'Photo captured time';
    const source = result.fromFile
      ? 'Source: browser, when the image was received'
      : 'Source: browser capture event (not a hardware exposure time)';

    return makeRow(label, formatTime(result.receivedAt), [source]);
  }

  function locationRows(result) {
    const coords = chooseCoordinates(result);
    const device = result.deviceLocation;
    const isLoading = result.step === 'location';
    const rows = [];

    // When the browser took its location reading
    rows.push(makeRow(
      'Location reading time',
      device ? formatTime(device.time) : isLoading ? 'Reading…' : DASH,
      device ? ['Source: browser location reading'] : [],
      isLoading
    ));

    // The coordinates we are using
    rows.push(makeRow(
      'Coordinates',
      coords ? formatCoordinates(coords) : isLoading ? 'Reading…' : 'Unavailable',
      [coords ? locationNote(result) : result.locationError],
      isLoading
    ));

    // Accuracy only belongs to the browser reading, never to the photo's GPS.
    let accuracyText = DASH;
    let accuracyNotes = [];

    if (isLoading) {
      accuracyText = 'Reading…';
    } else if (coords && coords.source === 'photo') {
      accuracyText = 'Not reported for EXIF GPS';

      if (device) {
        rows.push(makeRow('Device location (separate)', formatCoordinates(device), [formatAccuracy(device.accuracy)]));
      }
    } else if (coords) {
      accuracyText = formatAccuracy(device.accuracy);
      accuracyNotes = ['Reported by the browser; desktop locations may be approximate.'];
    }

    rows.push(makeRow('Reported accuracy', accuracyText, accuracyNotes, isLoading));
    return rows;
  }

  function addressRow(result) {
    if (result.step === 'address') {
      return makeRow('Address', 'Resolving…', [], true);
    }

    const address = result.address;

    if (!address) {
      return makeRow('Address', result.step === 'done' ? 'Unavailable (no coordinates)' : DASH);
    }

    const titles = {
      failed: 'Lookup failed',
      unavailable: 'No address found'
    };
    const notes = [];

    if (address.status === 'partial') {
      notes.push({ text: 'Partial address — missing: ' + address.missing.join(', ') + '.', cls: 'partial' });
    }

    if (address.status === 'failed') {
      notes.push({ text: address.message, cls: 'failed' });
    }

    if (address.parts) {
      const pieces = [];
      for (const key in ADDRESS_PART_LABELS) {
        if (address.parts[key]) pieces.push(ADDRESS_PART_LABELS[key] + ': ' + address.parts[key]);
      }
      notes.push(pieces.join(' · '));
      notes.push('Address data: OpenStreetMap Nominatim · ' + CONFIG.CREDIT + ' (read-only)');
    }

    return makeRow('Address', titles[address.status] || address.formatted || DASH, notes);
  }

  // Redraws the whole details panel from state.result.
  function render() {
    const result = state.result;

    if (!result) {
      el.rows.replaceChildren(...EMPTY_LABELS.map((label) => makeRow(label, DASH)));
      el.note.textContent = '';
      return;
    }

    el.rows.replaceChildren(
      timeRow(result),
      ...locationRows(result),
      addressRow(result)
    );

    el.note.textContent = chooseCoordinates(result) ? locationNote(result) : '';
  }


  // =====================================================
  // 9. WATERMARKED PHOTO (preview and download)


  // Look of the watermark panel in the bottom-right corner of the photo.
  const WATERMARK = {
    BACKGROUND: 'rgba(0, 0, 0, 0.65)',
    TEXT_COLOR: '#ffffff',
    PIN_COLOR: '#e53935',
    FONT_FAMILY: '"Segoe UI", Roboto, Arial, sans-serif'
  };

  function setExportMessage(text, isError = false) {
    el.exportMsg.textContent = text;
    el.exportMsg.className = 'export-msg' + (isError ? ' err' : '');
  }

  // The button works only when processing is finished and no image is being created.
  function updateExportControls() {
    const finished = Boolean(state.result) && state.result.step === 'done';

    el.download.disabled = !finished || state.exporting;
    el.downloadLabel.textContent = state.exporting ? 'Preparing image…' : 'Download Photo with Details';
  }

  // Called when location and address processing are finished (even if some details are unavailable).
  function onProcessingFinished() {
    setExportMessage('');
    updateExportControls();
    generateExport(); // the watermarked image is created automatically
  }

  // Forget the watermarked image of the previous photo and free its memory.
  function clearExport() {
    if (state.export) URL.revokeObjectURL(state.export.url);

    state.export = null;
    state.exporting = false;

    el.exportBox.hidden = true;
    setExportMessage('');
  }

  // The text of the watermark: { heading, details }.
  // Only the address and the date/time are shown. Missing information is shown as unavailable.
  function buildWatermarkLines(result) {
    const address = result.address;
    const hasAddress = Boolean(address) && (address.status === 'resolved' || address.status === 'partial') && Boolean(address.formatted);
    const details = [];

    // Address (the heading), or the reason it is unavailable
    let heading = 'Address unavailable';
    if (hasAddress) heading = address.formatted;
    else if (address && address.status === 'failed') details.push(address.message);
    else if (address) details.push('No address found for these coordinates');

    // Time (browser time, not the moment of the shutter)
    details.push((result.fromFile ? 'Received: ' : 'Browser capture: ') + formatTime(result.receivedAt));

    // Credit for the address data (required by OpenStreetMap)
    if (hasAddress) details.push(CONFIG.CREDIT);

    return { heading: heading, details: details };
  }

  // Splits text into lines that fit the given widths (the first line may be shorter).
  function wrapText(ctx, text, firstLineWidth, fullWidth) {
    const lines = [];
    let current = '';
    let limit = firstLineWidth;

    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      const attempt = current ? current + ' ' + word : word;

      if (ctx.measureText(attempt).width <= limit) {
        current = attempt;
        continue;
      }

      if (current) {
        lines.push(current);
        current = '';
        limit = fullWidth;
      }

      // A single word that is still too wide is cut into pieces.
      let rest = word;
      while (ctx.measureText(rest).width > limit) {
        let cut = Math.max(1, rest.length - 1);
        while (cut > 1 && ctx.measureText(rest.slice(0, cut)).width > limit) cut--;

        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
        limit = fullWidth;
      }
      current = rest;
    }

    lines.push(current);
    return lines;
  }

  function watermarkFont(bold, size) {
    return (bold ? 'bold ' : '') + size + 'px ' + WATERMARK.FONT_FAMILY;
  }

  // Measures the panel for one text size. Sizes, padding and margins all come from detailSize,
  // which itself comes from the image size, so the watermark scales with the photo.
  function measureWatermark(ctx, lines, imageWidth, detailSize) {
    const headingSize = Math.round(detailSize * 1.25);
    const padding = Math.round(detailSize * 0.8);
    const margin = Math.round(detailSize);
    const lineHeight = Math.round(detailSize * 1.35);
    const headingLineHeight = Math.round(headingSize * 1.3);
    const pinSize = Math.round(headingSize * 1.1);
    const pinGap = Math.round(detailSize * 0.4);

    const maxPanelWidth = Math.min(imageWidth - margin * 2, Math.round(imageWidth * 0.8));
    const maxTextWidth = Math.max(20, maxPanelWidth - padding * 2);

    const rows = []; // each row is one line of text, with its distance from the top of the panel
    let y = padding;
    let widest = 0;

    // Address heading: bold, with room for the pin icon on its first line
    ctx.font = watermarkFont(true, headingSize);
    const headingLines = wrapText(ctx, lines.heading, Math.max(20, maxTextWidth - pinSize - pinGap), maxTextWidth);

    headingLines.forEach((text, i) => {
      const width = ctx.measureText(text).width + (i === 0 ? pinSize + pinGap : 0);
      widest = Math.max(widest, width);
      rows.push({ text: text, bold: true, size: headingSize, y: y, pin: i === 0 });
      y += headingLineHeight;
    });
    y += Math.round(detailSize * 0.2);

    // Detail lines
    ctx.font = watermarkFont(false, detailSize);
    for (const line of lines.details) {
      for (const text of wrapText(ctx, line, maxTextWidth, maxTextWidth)) {
        widest = Math.max(widest, ctx.measureText(text).width);
        rows.push({ text: text, bold: false, size: detailSize, y: y, pin: false });
        y += lineHeight;
      }
    }

    return {
      rows: rows,
      padding: padding,
      margin: margin,
      pinSize: pinSize,
      pinGap: pinGap,
      radius: Math.round(detailSize * 0.7),
      width: Math.min(maxPanelWidth, Math.ceil(widest) + padding * 2),
      height: y - Math.round(detailSize * 0.35) + padding
    };
  }

  // Chooses the text size and places the panel in the bottom-right corner.
  // If the panel would be taller than the photo, the text is made smaller until it fits.
  function layoutWatermark(ctx, lines, imageWidth, imageHeight) {
    let detailSize = Math.max(12, Math.round(Math.min(imageWidth, imageHeight) * 0.025));
    let layout = measureWatermark(ctx, lines, imageWidth, detailSize);

    for (let attempt = 0; attempt < 8; attempt++) {
      if (layout.height <= imageHeight - layout.margin * 2 || detailSize <= 8) break;

      detailSize = Math.max(8, Math.floor(detailSize * 0.85));
      layout = measureWatermark(ctx, lines, imageWidth, detailSize);
    }

    layout.x = imageWidth - layout.margin - layout.width;
    layout.y = Math.max(0, imageHeight - layout.margin - layout.height);
    return layout;
  }

  function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);

    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
  }

  // A small red location pin: a round head, a pointed tip and a white dot.
  function drawPin(ctx, centerX, top, size) {
    const radius = size * 0.34;
    const centerY = top + radius;

    ctx.fillStyle = WATERMARK.PIN_COLOR;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, Math.PI * 0.8, Math.PI * 0.2); // round head
    ctx.lineTo(centerX, top + size);                                  // pointed tip
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = WATERMARK.TEXT_COLOR;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius * 0.4, 0, Math.PI * 2);          // white dot
    ctx.fill();
  }

  // Draws the dark panel, the pin and the right-aligned white text.
  function drawWatermark(ctx, layout) {
    roundedRectPath(ctx, layout.x, layout.y, layout.width, layout.height, layout.radius);
    ctx.fillStyle = WATERMARK.BACKGROUND;
    ctx.fill();

    const right = layout.x + layout.width - layout.padding;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';

    for (const row of layout.rows) {
      ctx.font = watermarkFont(row.bold, row.size);
      ctx.fillStyle = WATERMARK.TEXT_COLOR;
      ctx.fillText(row.text, right, layout.y + row.y);

      if (row.pin) {
        const textWidth = ctx.measureText(row.text).width;
        const pinCenterX = right - textWidth - layout.pinGap - layout.pinSize / 2;
        const pinTop = layout.y + row.y + Math.round((row.size - layout.pinSize) / 2);
        drawPin(ctx, pinCenterX, pinTop, layout.pinSize);
      }
    }

    ctx.textAlign = 'left'; // back to the default
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('The photo could not be loaded.'));
      image.src = url;
    });
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('The image could not be created.'));
      }, 'image/jpeg', CONFIG.EXPORT_QUALITY);
    });
  }

  // Draws the original photo with the watermark on top and returns a JPEG blob.
  // The canvas is exactly the photo's size (no extra space, no cropping).
  // The original (state.photoUrl) is only read, so the watermark is never stamped twice.
  async function createWatermarkedImage(result, photoUrl) {
    const image = await loadImage(photoUrl);

    if (!image.naturalWidth || !image.naturalHeight) {
      throw new Error('The photo could not be read.');
    }

    // Keep the aspect ratio, but make the longest side at most EXPORT_MAX_SIDE.
    const scale = Math.min(1, CONFIG.EXPORT_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot create the image.');

    ctx.drawImage(image, 0, 0, width, height);

    const layout = layoutWatermark(ctx, buildWatermarkLines(result), width, height);
    drawWatermark(ctx, layout);

    return canvasToBlob(canvas);
  }

  // Filename like photo-details-20261012-143005.jpg
  function makeFilename(date) {
    const two = (n) => String(n).padStart(2, '0');

    return 'photo-details-' +
      date.getFullYear() + two(date.getMonth() + 1) + two(date.getDate()) + '-' +
      two(date.getHours()) + two(date.getMinutes()) + two(date.getSeconds()) + '.jpg';
  }

  // Creates the watermarked image for the current photo and shows it in the photo preview.
  // Returns true when the image is ready.
  async function generateExport() {
    const result = state.result;
    if (state.exporting || !result || result.step !== 'done') return false;

    const run = state.run;
    const isCurrent = () => !isOutdated(run) && state.result === result;

    state.exporting = true; // disables the download button while the image is created
    updateExportControls();
    setExportMessage('Preparing image…');

    try {
      const blob = await createWatermarkedImage(result, state.photoUrl);
      if (!isCurrent()) return false; // a newer photo replaced this one: drop this image

      state.export = {
        blob: blob,
        url: URL.createObjectURL(blob),
        filename: makeFilename(new Date())
      };

      el.photo.src = state.export.url; // the preview now shows the watermarked photo
      setExportMessage('');
      return true;
    } catch (error) {
      if (isCurrent()) {
        setExportMessage((error.message || 'The image could not be created.') + ' Press the button to try again.', true);
      }
      return false;
    } finally {
      if (state.result === result) {
        state.exporting = false;
        updateExportControls(); // restore the button
      }
    }
  }

  function saveExport() {
    const link = document.createElement('a');
    link.href = state.export.url;
    link.download = state.export.filename;
    document.body.append(link);
    link.click();
    link.remove();
  }

  // Downloads the same image that is shown in the preview.
  async function onDownloadClick() {
    const result = state.result;
    if (state.exporting || !result) return;

    if (!state.export) await generateExport(); // e.g. retry after an earlier error

    if (state.result === result && state.export) saveExport();
  }


  // 10. START UP: connect buttons to the code above


  function init() {
    render();

    el.hint.textContent = isPhone
      ? 'Opens your phone camera where supported. Some browsers may show other options.'
      : 'Uses your webcam.';
    el.webcamLink.hidden = !isPhone;

    // The main button does a different job depending on the situation.
    el.take.addEventListener('click', () => {
      if (state.previewing) {
        captureStill();      // webcam is running: take the picture
      } else if (isPhone) {
        el.file.click();     // phone: open the camera app
      } else {
        startPreview();      // computer: start the webcam
      }
    });

    el.webcamLink.addEventListener('click', () => startPreview());
    el.camSelect.addEventListener('change', () => startPreview(el.camSelect.value));
    el.file.addEventListener('change', onFileChosen);
    el.download.addEventListener('click', onDownloadClick);

    // Turn the camera off when the user leaves the tab or the page.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (state.previewing || state.busy)) {
        state.run++;
        stopCamera();
        setStage('placeholder');
        setButton('Take Photo');
        setStatus('Camera stopped because the tab was hidden.');
      }
    });

    window.addEventListener('pagehide', () => {
      state.run++;
      stopCamera();
    });

    if (!window.isSecureContext) {
      setStatus('Camera and location need HTTPS or localhost.', 'warn');
    }
  }

  init();
})();