import { installUpdates } from '/pwa-update.js';

const AUTH_MARKER = 'stencil-cnc:linked';
const AUTH_WORKSPACE = 'stencil-cnc:workspace-id';
const AUTH_DEVICE_LABEL = 'stencil-cnc:device-label';
const state = {
  editorLoaded: false,
  device: null
};

// The editor owns the viewport and gives its side panes their own scroll
// containers. Browsers can nevertheless restore an old document scroll
// position before authentication finishes, and focus/scrollIntoView can move
// an overflow-hidden root programmatically. Once that happens the fixed-height
// editor appears above a large blank page and the user cannot scroll it back.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

function pinEditorViewport() {
  if (!document.body.classList.contains('editor-open')) return;
  const root = document.scrollingElement;
  if ((root?.scrollTop ?? 0) === 0 && (root?.scrollLeft ?? 0) === 0 &&
      window.scrollX === 0 && window.scrollY === 0) return;
  if (root) {
    root.scrollTop = 0;
    root.scrollLeft = 0;
  }
  window.scrollTo(0, 0);
}

function lockEditorViewport() {
  document.documentElement.classList.add('editor-open');
  document.body.classList.add('editor-open');
  pinEditorViewport();
  requestAnimationFrame(pinEditorViewport);
}

function unlockEditorViewport() {
  document.documentElement.classList.remove('editor-open');
  document.body.classList.remove('editor-open');
}

window.addEventListener('scroll', pinEditorViewport, { passive: true });
window.addEventListener('pageshow', () => requestAnimationFrame(pinEditorViewport));

function isBusy() {
  return Boolean(window.stencilCncIsBusy?.());
}

function showStatus(message, tone = 'neutral') {
  const status = document.getElementById('app-status');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

async function requestJson(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function showGate(prefilledCode = '', { relink = false, currentLabel = '' } = {}) {
  unlockEditorViewport();
  document.getElementById('gate-screen')?.removeAttribute('hidden');
  document.getElementById('app-main')?.setAttribute('hidden', '');
  const input = document.getElementById('invite-code-input');
  if (input && prefilledCode) input.value = prefilledCode;
  const help = document.getElementById('invite-help');
  if (help) {
    help.textContent = relink
      ? `This browser is currently “${currentLabel || 'Linked device'}”. Continue only if you want it to use the invited workspace.`
      : 'Use the one-time code shared by the workspace owner.';
  }
  const cancel = document.getElementById('btn-cancel-relink');
  if (cancel) cancel.hidden = !relink;
  input?.focus();
}

function clearInviteFromUrl() {
  const shareHash = location.pathname.startsWith('/share/') ? location.hash : '';
  history.replaceState({}, document.title, `${location.pathname}${shareHash}`);
}

async function openEditor(device, { offline = false } = {}) {
  if (!device?.workspaceId) {
    throw new Error('Reconnect once so Kerfloom can identify this device workspace.');
  }
  state.device = device || null;
  lockEditorViewport();
  document.getElementById('gate-screen')?.setAttribute('hidden', '');
  document.getElementById('app-main')?.removeAttribute('hidden');
  const deviceLabel = document.getElementById('device-label');
  if (deviceLabel) deviceLabel.textContent = device?.label || (offline ? 'Offline workspace' : 'Linked device');
  showStatus(offline ? 'Offline — changes will sync when connected' : 'Server workspace ready', offline ? 'warning' : 'success');

  if (!state.editorLoaded) {
    state.editorLoaded = true;
    try {
      const storage = await import('/storage.js');
      storage.configureStorageWorkspace(device.workspaceId);
      const editor = await import('/editor.js');
      await editor.startEditor?.({ device, offline });
    } catch (error) {
      state.editorLoaded = false;
      console.error(error);
      showStatus('The editor could not be loaded. Reconnect and refresh.', 'danger');
    }
  }
}

async function checkAccess() {
  const params = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const code = params.get('code') || params.get('invite') || fragment.get('invite') || '';

  try {
    const result = await requestJson('/api/auth/me', { cache: 'no-store' });
    if (code) {
      showGate(code, { relink: true, currentLabel: result.device.label });
      return;
    }
    localStorage.setItem(AUTH_MARKER, '1');
    localStorage.setItem(AUTH_WORKSPACE, result.device.workspaceId);
    localStorage.setItem(AUTH_DEVICE_LABEL, result.device.label || 'Linked device');
    await openEditor(result.device);
    if (location.search) clearInviteFromUrl();
  } catch (error) {
    if (error.status === 401) {
      localStorage.removeItem(AUTH_MARKER);
      showGate(code);
      return;
    }

    // A previously linked installed PWA remains useful without a connection.
    // Revocation takes effect on the next successful online check; cached code
    // and local projects cannot be remotely erased while the device is offline.
    const offlineWorkspaceId = localStorage.getItem(AUTH_WORKSPACE);
    if (!code && localStorage.getItem(AUTH_MARKER) === '1' && offlineWorkspaceId) {
      await openEditor({
        workspaceId: offlineWorkspaceId,
        label: localStorage.getItem(AUTH_DEVICE_LABEL) || 'Offline workspace',
      }, { offline: true });
      return;
    }
    showGate(code);
    const gateError = document.getElementById('gate-error');
    if (gateError) {
      gateError.textContent = 'Connect to the internet once to activate this device.';
      gateError.hidden = false;
    }
  }
}

function wireGate() {
  const form = document.getElementById('gate-form');
  form?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    const errorNode = document.getElementById('gate-error');
    const code = document.getElementById('invite-code-input')?.value || '';
    const label = document.getElementById('device-label-input')?.value || '';
    if (errorNode) errorNode.hidden = true;
    if (submit) submit.disabled = true;

    try {
      const result = await requestJson('/api/auth/redeem', {
        method: 'POST',
        body: JSON.stringify({ code, label })
      });
      localStorage.setItem(AUTH_MARKER, '1');
      localStorage.setItem(AUTH_WORKSPACE, result.device.workspaceId);
      localStorage.setItem(AUTH_DEVICE_LABEL, result.device.label || 'Linked device');
      clearInviteFromUrl();
      await openEditor(result.device);
    } catch (error) {
      if (errorNode) {
        errorNode.textContent = error.message;
        errorNode.hidden = false;
      }
    } finally {
      if (submit) submit.disabled = false;
    }
  });
  document.getElementById('btn-cancel-relink')?.addEventListener('click', () => {
    clearInviteFromUrl();
    void checkAccess();
  });
}

wireGate();
installUpdates({ appName: 'Kerfloom', isBusy });
checkAccess();
