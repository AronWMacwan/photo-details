(() => {
  'use strict';

  // ---------- Configuration ----------

  const CONFIG = {
    NOMINATIM_URL: 'https://nominatim.openstreetmap.org/reverse',
    CONTACT_EMAIL: '',
    GEOCODE_TIMEOUT_MS: 10000,
    GEO_TIMEOUT_MS: 15000,
    LOCALE: undefined
  };

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
    file: $('fileInput')
  };

  const state = {
    session: 0,
    previewToken: 0,
    stream: null,
    url: null,
    previewing: false,
    busy: false,
    result: null,
    abort: null
  };

  // Device detection is a hint, not a guarantee.
  const isPhone = (() => {
    const mobile = navigator.userAgentData?.mobile;

    if (typeof mobile === 'boolean') return mobile;

    return (
      /Android|iPhone|iPod|iPad|Mobile/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' &&
        navigator.maxTouchPoints > 1)
    );
  })();

  // ---------- UI helpers ----------

  function setStatus(message, kind = 'info') {
    el.bannerText.textContent = message;
    el.banner.className = `banner ${kind}`;
  }

  function setStage(mode) {
    el.placeholder.hidden = mode !== 'placeholder';
    el.video.hidden = mode !== 'video';
    el.photo.hidden = mode !== 'photo';

    el.tag.hidden = mode === 'placeholder';
    el.tag.textContent =
      mode === 'video' ? 'Live preview' : 'Captured photo';
  }

  function setButton(label, outline = false) {
    el.takeLabel.textContent = label;
    el.take.className = `btn ${outline ? 'outline' : 'primary'}`;
  }

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
    return `±${Math.round(accuracy)} m`;
  }

  function formatCoordinates({ lat, lng }) {
    const latitude =
      `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}`;

    const longitude =
      `${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;

    return `${latitude}, ${longitude}`;
  }

  // ---------- Camera ----------

  function cameraError(error) {
    if (!window.isSecureContext) {
      return 'Camera access needs HTTPS or localhost.';
    }

    const messages = {
      NotAllowedError:
        'Camera access was denied. Allow access in your browser settings.',
      SecurityError:
        'Camera access is blocked by browser security settings.',
      NotFoundError:
        'No suitable camera was found.',
      OverconstrainedError:
        'The selected camera or camera settings are unavailable.',
      NotReadableError:
        'The camera could not be read. It may be in use by another app.'
    };

    return messages[error?.name] || 'The camera could not be started.';
  }

  function stopCamera() {
    // Pending camera requests become outdated.
    state.previewToken++;

    state.stream?.getTracks().forEach((track) => track.stop());

    state.stream = null;
    state.previewing = false;

    el.video.srcObject = null;
    el.camRow.hidden = true;

    setBusy(false);
  }

  function cancelPending() {
    state.abort?.abort();
    state.abort = null;
  }

  async function listCameras(activeId) {
    const token = state.previewToken;

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();

      if (token !== state.previewToken) return;

      const cameras = devices.filter(
        (device) => device.kind === 'videoinput'
      );

      const options = cameras.map((camera, index) => {
        return new Option(
          camera.label || `Camera ${index + 1}`,
          camera.deviceId
        );
      });

      el.camSelect.replaceChildren(...options);

      if (activeId) el.camSelect.value = activeId;

      el.camRow.hidden = cameras.length < 2;
    } catch {
      if (token === state.previewToken) {
        el.camRow.hidden = true;
      }
    }
  }

  async function startPreview(deviceId) {
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = window.isSecureContext
        ? 'This browser does not support camera access.'
        : cameraError();

      setStatus(message, 'err');
      return;
    }

    stopCamera();
    cancelPending();
    state.session++;
    clearResult();

    const token = state.previewToken;

    setBusy(true);
    setStatus('Starting camera…');

    try {
      const video = deviceId
        ? { deviceId: { exact: deviceId } }
        : {
            facingMode: {
              ideal: isPhone ? 'environment' : 'user'
            }
          };

      const stream = await navigator.mediaDevices.getUserMedia({
        video,
        audio: false
      });

      // A newer request replaced this one.
      if (token !== state.previewToken) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      state.stream = stream;
      el.video.srcObject = stream;

      await el.video.play();

      if (token !== state.previewToken) return;

      state.previewing = true;

      setStage('video');
      setButton('Capture Photo');
      setStatus('Camera ready. Press Capture Photo.');

      const activeId = stream
        .getVideoTracks()[0]
        .getSettings()
        .deviceId;

      listCameras(activeId);
    } catch (error) {
      if (token !== state.previewToken) return;

      stopCamera();
      setStage('placeholder');
      setButton('Take Photo');
      setStatus(cameraError(error), 'err');
    } finally {
      if (token === state.previewToken) {
        setBusy(false);
      }
    }
  }

  function captureStill() {
    if (state.busy || !el.video.videoWidth) return;

    setBusy(true);

    const token = state.previewToken;

    try {
      const canvas = document.createElement('canvas');
      canvas.width = el.video.videoWidth;
      canvas.height = el.video.videoHeight;

      canvas.getContext('2d').drawImage(el.video, 0, 0);

      const at = new Date();

      canvas.toBlob((blob) => {
        if (token !== state.previewToken) return;

        stopCamera();

        if (!blob) {
          showCaptureError();
          return;
        }

        processPhoto(blob, { external: false, at });
      }, 'image/jpeg', 0.92);
    } catch {
      stopCamera();
      showCaptureError();
    }
  }

  function showCaptureError() {
    setStage('placeholder');
    setButton('Take Photo');
    setStatus('The photo could not be captured. Try again.', 'err');
  }

  function onFileChosen() {
    const file = el.file.files?.[0];

    // Allow the same file to trigger another change event.
    el.file.value = '';

    if (!file) return;

    processPhoto(file, {
      external: true,
      at: new Date()
    });
  }

  // ---------- Photo GPS and browser location ----------

  function validCoords(lat, lng) {
    return (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    );
  }

  async function readExif(blob) {
    // The current version reads EXIF GPS only.
    if (!window.exifr?.gps) return null;

    try {
      const gps = await window.exifr.gps(blob);

      if (!gps || !validCoords(gps.latitude, gps.longitude)) {
        return null;
      }

      return {
        coords: {
          lat: gps.latitude,
          lng: gps.longitude
        }
      };
    } catch {
      return null;
    }
  }

  function getLocation() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) {
        reject(new Error('Location is not supported by this browser.'));
        return;
      }

      if (!window.isSecureContext) {
        reject(new Error('Location needs HTTPS or localhost.'));
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;

          if (!validCoords(latitude, longitude)) {
            reject(new Error('The browser returned invalid coordinates.'));
            return;
          }

          resolve({
            lat: latitude,
            lng: longitude,
            accuracy: Number.isFinite(accuracy) ? accuracy : null,
            time: new Date(position.timestamp || Date.now())
          });
        },

        (error) => {
          const messages = {
            1: 'Location permission was denied.',
            2: 'Location is unavailable right now.',
            3: 'The location request timed out.'
          };

          reject(new Error(
            messages[error.code] || 'Location could not be retrieved.'
          ));
        },

        {
          enableHighAccuracy: true,
          timeout: CONFIG.GEO_TIMEOUT_MS,
          maximumAge: 0
        }
      );
    });
  }

  function selectedCoords(result) {
    if (result.exif?.coords) {
      return {
        ...result.exif.coords,
        source: 'photo'
      };
    }

    if (result.device) {
      return {
        lat: result.device.lat,
        lng: result.device.lng,
        source: 'device'
      };
    }

    return null;
  }

  // ---------- Address request timing and cache ----------

  // This spacing applies to this tab only.
  // Multiple users require an application-wide rate-limit strategy.
  const GEO_MIN_GAP_MS = 1100;

  const geoCache = new Map();
  let nextSlot = 0;

  function cancelled() {
    return new DOMException('Cancelled', 'AbortError');
  }

  function sleep(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(cancelled());
        return;
      }

      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, milliseconds);

      function onAbort() {
        clearTimeout(timer);
        reject(cancelled());
      }

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function waitForSlot(signal) {
    const previousSlot = nextSlot;
    const slot = Math.max(Date.now(), previousSlot);

    nextSlot = slot + GEO_MIN_GAP_MS;

    try {
      const delay = slot - Date.now();

      if (delay > 0) {
        await sleep(delay, signal);
      }
    } catch (error) {
      // Return the slot only if no later request reserved another one.
      if (nextSlot === slot + GEO_MIN_GAP_MS) {
        nextSlot = previousSlot;
      }

      throw error;
    }
  }

  // ---------- Reverse geocoding ----------

  function nominatimToResult(data) {
    if (!data || data.error || !data.address) {
      return { status: 'unavailable' };
    }

    const address = data.address;

    const parts = {
      building: [
        address.house_number,
        address.house_name || address.building
      ].filter(Boolean).join(' ') || null,

      street:
        address.road ||
        address.pedestrian ||
        address.footway ||
        null,

      locality:
        address.neighbourhood ||
        address.suburb ||
        address.city_district ||
        null,

      city:
        address.city ||
        address.town ||
        address.village ||
        address.municipality ||
        null,

      district: address.state_district || address.county || null,
      state: address.state || null,
      postal: address.postcode || null,
      country: address.country || null
    };

    const missing = [];

    if (!parts.street) missing.push('street');
    if (!parts.building) missing.push('house/building details');
    if (!parts.city) missing.push('city');

    return {
      status: missing.length ? 'partial' : 'resolved',
      formatted: data.display_name,
      parts,
      missing
    };
  }

  const provider = {
    name: 'OpenStreetMap Nominatim',
    credit: '© OpenStreetMap contributors',

    isConfigured() {
      return Boolean(CONFIG.NOMINATIM_URL);
    },

    async geocode(lat, lng, signal) {
      if (signal.aborted) throw cancelled();

      const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;

      if (geoCache.has(key)) {
        return geoCache.get(key);
      }

      await waitForSlot(signal);

      if (signal.aborted) throw cancelled();

      const query = new URLSearchParams({
        format: 'jsonv2',
        lat,
        lon: lng,
        zoom: 18,
        addressdetails: 1,
        'accept-language': 'en'
      });

      if (CONFIG.CONTACT_EMAIL) {
        query.set('email', CONFIG.CONTACT_EMAIL);
      }

      const controller = new AbortController();
      let timedOut = false;

      const onAbort = () => controller.abort();

      signal.addEventListener('abort', onAbort, { once: true });

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, CONFIG.GEOCODE_TIMEOUT_MS);

      try {
        const response = await fetch(
          `${CONFIG.NOMINATIM_URL}?${query}`,
          {
            signal: controller.signal,
            headers: { Accept: 'application/json' }
          }
        );

        if (response.status === 429) {
          throw new Error('RATE_LIMIT');
        }

        if (!response.ok) {
          throw new Error(`HTTP_${response.status}`);
        }

        const data = await response.json();
        const result = nominatimToResult(data);

        geoCache.set(key, result);

        return result;
      } catch (error) {
        if (timedOut) throw new Error('TIMEOUT');
        throw error;
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      }
    }
  };

  async function resolveAddress(lat, lng, signal) {
    if (!provider.isConfigured()) {
      return { status: 'notconfigured' };
    }

    if (!navigator.onLine) {
      return {
        status: 'failed',
        message: 'You appear to be offline.'
      };
    }

    try {
      return await provider.geocode(lat, lng, signal);
    } catch (error) {
      if (error.name === 'AbortError') {
        return { status: 'cancelled' };
      }

      const messages = {
        RATE_LIMIT: 'Address service is busy. Try again in a moment.',
        TIMEOUT: 'Address lookup timed out.'
      };

      return {
        status: 'failed',
        message:
          messages[error.message] ||
          'Address lookup failed because of a network or service error.'
      };
    }
  }

  // ---------- Main photo workflow ----------

  function clearResult() {
    if (state.url) {
      URL.revokeObjectURL(state.url);
    }

    state.url = null;
    state.result = null;

    el.photo.removeAttribute('src');
    render();
  }

  function fulfilledValue(outcome) {
    return outcome.status === 'fulfilled' ? outcome.value : null;
  }

  async function processPhoto(blob, meta) {
    const session = ++state.session;

    stopCamera();
    cancelPending();
    clearResult();

    const controller = new AbortController();

    state.abort = controller;
    state.url = URL.createObjectURL(blob);

    el.photo.src = state.url;
    setStage('photo');

    const result = {
      external: meta.external,
      received: meta.at,
      exif: null,
      device: null,
      deviceError: null,
      addr: null,
      phase: 'location'
    };

    state.result = result;

    setButton('Take Another Photo', true);
    el.take.disabled = true;

    setStatus('Reading photo location…');
    render();

    // Read photo GPS and browser location concurrently.
    const [photoLocation, deviceLocation] = await Promise.allSettled([
      meta.external ? readExif(blob) : Promise.resolve(null),
      getLocation()
    ]);

    if (session !== state.session) return;

    result.exif = fulfilledValue(photoLocation);
    result.device = fulfilledValue(deviceLocation);

    if (deviceLocation.status === 'rejected') {
      result.deviceError = deviceLocation.reason.message;
    }

    const coordinates = selectedCoords(result);

    result.phase = coordinates ? 'address' : 'done';
    el.take.disabled = false;

    render();

    if (!coordinates) {
      setStatus(
        result.deviceError || 'No location is available.',
        'warn'
      );
      return;
    }

    setStatus('Resolving address…');

    const address = await resolveAddress(
      coordinates.lat,
      coordinates.lng,
      controller.signal
    );

    // Ignore results belonging to an older photo.
    if (
      session !== state.session ||
      address.status === 'cancelled'
    ) {
      return;
    }

    result.addr = address;
    result.phase = 'done';

    render();

    const messages = {
      resolved: 'Done. Details are shown below.',
      partial: 'Photo processed. Only a partial address was found.',
      unavailable: 'Photo processed. No address was found.',
      notconfigured: 'Address service is not configured.'
    };

    setStatus('Done. Details are shown below.', 'ok');
  }

  // ---------- Result rendering ----------

  const DASH = '—';

  const emptyLabels = [
    'Photo received time',
    'Location reading time',
    'Coordinates',
    'Reported accuracy',
    'Address'
  ];

  const addressFields = {
    building: 'Building',
    street: 'Street',
    locality: 'Area',
    city: 'City',
    district: 'District',
    state: 'State',
    postal: 'PIN',
    country: 'Country'
  };

  function row(label, value, options = {}) {
    const wrapper = document.createElement('div');
    wrapper.className = 'row';

    const title = document.createElement('dt');
    title.textContent = label;

    const description = document.createElement('dd');

    const main = document.createElement('span');
    main.textContent = value;

    if (options.pending) {
      main.className = 'pending';
    }

    description.append(main);

    for (const note of options.subs || []) {
      const span = document.createElement('span');

      span.className = note.cls || 'sub2';
      span.textContent = note.text;

      description.append(span);
    }

    wrapper.append(title, description);

    return wrapper;
  }

  function detailRow(label, value, notes = [], pending = false) {
    return row(label, value, {
      pending,
      subs: notes.filter(Boolean).map((text) => ({ text }))
    });
  }

  function locationNote(result) {
    if (selectedCoords(result)?.source === 'photo') {
      return 'Location taken from the photo’s embedded GPS.';
    }

    return result.external
      ? 'Device location sampled after the photo returned.'
      : 'Device location sampled after the frame was captured.';
  }

  function locationRows(result) {
    const coordinates = selectedCoords(result);
    const pending = result.phase === 'location';
    const device = result.device;

    const locationTime = device
      ? formatTime(device.time)
      : pending ? 'Reading…' : DASH;

    const coordinateText = coordinates
      ? formatCoordinates(coordinates)
      : pending ? 'Reading…' : 'Unavailable';

    const rows = [
      detailRow(
        'Location reading time',
        locationTime,
        device ? ['Source: browser location reading'] : [],
        pending
      ),

      detailRow(
        'Coordinates',
        coordinateText,
        [coordinates ? locationNote(result) : result.deviceError],
        pending
      )
    ];

    let accuracy = pending ? 'Reading…' : DASH;

    if (coordinates?.source === 'photo') {
      accuracy = 'Not reported for EXIF GPS';

      if (device) {
        rows.push(
          detailRow(
            'Device location (separate)',
            formatCoordinates(device),
            [formatAccuracy(device.accuracy)]
          )
        );
      }
    } else if (device) {
      accuracy = formatAccuracy(device.accuracy);
    }

    const accuracyNotes =
      device && coordinates?.source === 'device'
        ? ['Reported by the browser; desktop locations may be approximate.']
        : [];

    rows.push(
      detailRow('Reported accuracy', accuracy, accuracyNotes, pending)
    );

    return rows;
  }

  function addressRow(result) {
    if (result.phase === 'address') {
      return detailRow('Address', 'Resolving…', [], true);
    }

    const address = result.addr;

    if (!address) {
      const value = result.phase === 'done'
        ? 'Unavailable (no coordinates)'
        : DASH;

      return detailRow('Address', value);
    }

    const labels = {
      failed: 'Lookup failed',
      unavailable: 'No address found',
      notconfigured: 'Address service not configured'
    };

    const notes = [];

    if (address.status === 'partial') {
      notes.push({
        text: `Partial address — missing: ${address.missing.join(', ')}.`,
        cls: 'partial'
      });
    }

    if (address.message) {
      notes.push({
        text: address.message,
        cls: 'failed'
      });
    }

    if (address.parts) {
      const components = Object.entries(addressFields)
        .filter(([key]) => address.parts[key])
        .map(([key, label]) => `${label}: ${address.parts[key]}`);

      notes.push({ text: components.join(' · ') });

      notes.push({
        text:
          `Address data: ${provider.name} · ${provider.credit} (read-only)`
      });
    }

    return row(
      'Address',
      labels[address.status] || address.formatted || DASH,
      { subs: notes }
    );
  }

  function render() {
    const result = state.result;

    if (!result) {
      el.rows.replaceChildren(
        ...emptyLabels.map((label) => row(label, DASH))
      );

      el.note.textContent = '';
      return;
    }

    const label = result.external
      ? 'Photo received time'
      : 'Photo captured time';

    const source = result.external
      ? 'Source: browser, when the image was received'
      : 'Source: browser capture event (not a hardware exposure time)';

    el.rows.replaceChildren(
      detailRow(label, formatTime(result.received), [source]),
      ...locationRows(result),
      addressRow(result)
    );

    el.note.textContent = selectedCoords(result)
      ? locationNote(result)
      : '';
  }

  // ---------- Events ----------

  function init() {
    render();

    el.hint.textContent = isPhone
      ? 'Opens your phone camera where supported. Some browsers may show other options.'
      : 'Uses your webcam.';

    el.webcamLink.hidden = !isPhone;

    el.take.addEventListener('click', () => {
      if (state.previewing) {
        captureStill();
      } else if (isPhone) {
        el.file.click();
      } else {
        startPreview();
      }
    });

    el.webcamLink.addEventListener('click', () => {
      startPreview();
    });

    el.camSelect.addEventListener('change', () => {
      startPreview(el.camSelect.value);
    });

    el.file.addEventListener('change', onFileChosen);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && (state.previewing || state.busy)) {
        stopCamera();
        setStage('placeholder');
        setButton('Take Photo');
        setStatus('Camera stopped because the tab was hidden.');
      }
    });

    window.addEventListener('pagehide', () => {
      state.session++;
      cancelPending();
      stopCamera();
    });

    if (!window.isSecureContext) {
      setStatus(
        'Camera and location need HTTPS or localhost.',
        'warn'
      );
    }
  }

  init();
})();