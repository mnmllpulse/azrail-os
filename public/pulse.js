'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const cached = (k, v) => {
    try {
      if (v !== undefined) sessionStorage.setItem(k, String(v));
      return sessionStorage.getItem(k) || '';
    } catch {
      return '';
    }
  };
  const uuid = () => typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : String(Date.now()) + Math.random().toString(16).slice(2);

  let token = cached('azrail_ultimate_token');
  let project = cached('azrail_pulse_project');
  let mission = cached('azrail_pulse_mission');
  let timer = null;
  let busy = false;
  let presenceTimer = null;
  let globeReady = false;
  let mode = cached('azrail_pulse_mode') || 'auto';
  let knownProjects = [];
  let studioCatalogData = [];
  let activeCapability = null;

  const presenceSession = cached('azrail_pulse_presence') || ('s_' + uuid().replaceAll('-', ''));
  cached('azrail_pulse_presence', presenceSession);

  const labels = {
    accepted: 'Принято',
    queued: 'В очереди',
    planning: 'Планирование',
    executing: 'Выполнение',
    verifying: 'Проверка',
    checking: 'Проверка',
    completed: 'Готово',
    cancelled: 'Отменено',
    failed: 'Ошибка',
    done: 'Готово',
  };

  function notice(text) {
    const el = $('notice');
    if (el) el.textContent = text || '';
  }

  function headers(hasJson, key) {
    const h = { Authorization: 'Bearer ' + token };
    if (hasJson) h['Content-Type'] = 'application/json';
    if (key) h['Idempotency-Key'] = key;
    return h;
  }

  async function api(path, opt = {}) {
    if (!token) throw Object.assign(new Error('Подключите ключ AZRAIL.'), { status: 401 });
    const method = opt.method || 'GET';
    const body = opt.body;
    const response = await fetch(path, {
      method,
      headers: headers(body !== undefined, opt.key || ''),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await response.json(); } catch {}
    if (!response.ok) throw Object.assign(new Error(data.error || 'Сервис недоступен.'), { status: response.status, code: data.code });
    return data;
  }

  function openAccess(msg) {
    const panel = $('access');
    if (!panel) return;
    panel.hidden = false;
    const input = $('accessKey');
    if (input) {
      input.value = token || '';
      input.focus();
    }
    const noticeEl = $('accessNotice');
    if (noticeEl) noticeEl.textContent = msg || '';
  }

  function closeAccess() {
    const panel = $('access');
    if (panel) panel.hidden = true;
  }

  function setBusy(value) {
    busy = value;
    const create = $('createButton');
    const idea = $('idea');
    if (create) create.disabled = value;
    if (idea) idea.readOnly = value;
  }

  function money(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '$0';
    return '$' + (Math.abs(n) >= 1 ? n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '') : n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
  }

  function sendPresenceToGlobe(sessions) {
    if (!globeReady) return;
    const frame = $('pulseGlobe');
    frame?.contentWindow?.postMessage({ type: 'pulse:presence', sessions: Array.isArray(sessions) ? sessions : [] }, location.origin);
  }

  async function heartbeatPresence() {
    clearTimeout(presenceTimer);
    if (!token || document.hidden) return;
    try {
      await api('/api/azrail/presence', { method: 'POST', body: { sessionId: presenceSession, projectId: project || undefined } });
      const qs = new URLSearchParams({ sessionId: presenceSession });
      if (project) qs.set('projectId', project);
      const data = await api('/api/azrail/presence?' + qs.toString());
      sendPresenceToGlobe(data.sessions);
    } catch (e) {
      if (e?.status === 401) return;
    } finally {
      if (token && !document.hidden) presenceTimer = setTimeout(heartbeatPresence, 30000);
    }
  }

  function setMode(next) {
    mode = next || 'auto';
    cached('azrail_pulse_mode', mode);
    for (const btn of document.querySelectorAll('[data-mode]')) {
      btn.classList.toggle('active', btn.dataset.mode === mode);
    }
  }

  function setProgress(status) {
    const stage = status === 'completed' || status === 'done' ? 4
      : status === 'verifying' || status === 'checking' ? 3
        : status === 'executing' || status === 'repairing' ? 2
          : status === 'planning' ? 1 : 0;
    for (const el of document.querySelectorAll('#progress .step')) {
      const n = Number(el.dataset.stage);
      el.classList.toggle('done', n < stage);
      el.classList.toggle('active', n === stage);
    }
  }

  async function connect() {
    const candidate = $('accessKey')?.value.trim();
    if (!candidate) {
      const noticeEl = $('accessNotice');
      if (noticeEl) noticeEl.textContent = 'Введите ключ доступа.';
      return;
    }
    const previous = token;
    token = candidate;
    try {
      const me = await api('/api/azrail/me');
      cached('azrail_ultimate_token', token);
      closeAccess();
      notice('AZRAIL подключён: ' + (me.account?.name || 'доступ подтверждён') + '.');
    } catch (e) {
      token = previous;
      const noticeEl = $('accessNotice');
      if (noticeEl) noticeEl.textContent = e.message;
    }
  }

  async function ensureProjectList() {
    const data = await api('/api/azrail/projects');
    knownProjects = Array.isArray(data.projects) ? data.projects : [];
    const existing = knownProjects.find((p) => p.id === project);
    if (existing) return existing.id;
    if (knownProjects.length) {
      project = knownProjects[0].id;
      cached('azrail_pulse_project', project);
      return project;
    }
    project = '';
    cached('azrail_pulse_project', '');
    return '';
  }

  function projectNameFrom(message) {
    const clean = (message || '').replace(/\s+/g, ' ').trim();
    return clean.length > 54 ? clean.slice(0, 54) + '…' : clean || 'Новый проект';
  }

  async function ensureProject(message) {
    const existing = await ensureProjectList();
    if (existing) return existing;
    const data = await api('/api/azrail/projects', { method: 'POST', body: { name: projectNameFrom(message) } });
    project = data.project.id;
    cached('azrail_pulse_project', project);
    heartbeatPresence();
    return project;
  }

  function workspaceRow(title, meta) {
    const row = document.createElement('div');
    row.className = 'workspace-row';
    const b = document.createElement('b');
    b.textContent = title || '—';
    row.append(b);
    if (meta) {
      const span = document.createElement('span');
      span.textContent = meta;
      row.append(span);
    }
    return row;
  }

  function workspaceEmpty(text) {
    const el = document.createElement('div');
    el.className = 'workspace-empty';
    el.textContent = text;
    return el;
  }

  function renderWorkspaceList(id, items, map, limit = 12) {
    const root = $(id);
    if (!root) return;
    root.replaceChildren();
    const list = Array.isArray(items) ? items.slice(0, limit) : [];
    if (!list.length) {
      root.append(workspaceEmpty('Нет данных'));
      return;
    }
    for (const item of list) {
      const [title, meta] = map(item);
      root.append(workspaceRow(title, meta));
    }
    if (Array.isArray(items) && items.length > limit) {
      root.append(workspaceEmpty('Ещё ' + (items.length - limit) + '…'));
    }
  }

  async function loadProjectWorkspace(projectId, meta) {
    const title = $('projectTitle');
    const desc = $('projectDescription');
    if (title) title.textContent = meta?.name || projectId;
    if (desc) desc.textContent = meta?.description || ('Project ID: ' + projectId);
    const data = await api('/api/azrail/projects/' + encodeURIComponent(projectId) + '/workspace');
    const files = data.files?.files || [];
    const memory = Array.isArray(data.memory) ? data.memory : [];
    const versions = Array.isArray(data.versions) ? data.versions : [];
    const history = Array.isArray(data.history) ? data.history : [];
    const filesCount = $('filesCount');
    const memoryCount = $('memoryCount');
    const versionsCount = $('versionsCount');
    const historyCount = $('historyCount');
    if (filesCount) filesCount.textContent = String(files.length) + (data.files?.truncated ? '+' : '');
    if (memoryCount) memoryCount.textContent = String(memory.length);
    if (versionsCount) versionsCount.textContent = String(versions.length);
    if (historyCount) historyCount.textContent = String(history.length);
    renderWorkspaceList('projectFiles', files, (f) => [f.path, typeof f.size === 'number' ? String(f.size) + ' B' : '']);
    renderWorkspaceList('projectMemory', memory, (m) => ['[' + (m.category || 'memory') + '] ' + (m.key || 'fact'), m.value || '']);
    renderWorkspaceList('projectVersions', versions, (v) => ['v' + (v.versionNumber ?? '?') + (v.summary ? ' · ' + v.summary : ''), v.createdByAgent || v.createdAt || '']);
    renderWorkspaceList('projectHistory', history, (x) => [(x.intent || x.agent || 'task') + ' · ' + (x.status || ''), x.output_summary || x.error || x.started_at || '']);
  }

  function renderProjectButtons() {
    const root = $('projectList');
    if (!root) return;
    root.replaceChildren();
    if (!knownProjects.length) {
      root.append(workspaceEmpty('Проектов пока нет. Первый создастся из Composer.'));
      return;
    }
    for (const p of knownProjects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'project-item' + (p.id === project ? ' active' : '');
      const name = document.createElement('b');
      name.textContent = p.name || p.id;
      const meta = document.createElement('span');
      meta.textContent = (p.status || 'active') + ' · ' + (p.updatedAt || '');
      button.append(name, meta);
      button.addEventListener('click', async () => {
        if (busy && p.id !== project) {
          notice('Сначала дождитесь завершения текущей миссии перед сменой активного проекта.');
          return;
        }
        if (p.id !== project) {
          project = p.id;
          cached('azrail_pulse_project', project);
          mission = '';
          cached('azrail_pulse_mission', '');
          const missionEl = $('mission');
          if (missionEl) missionEl.hidden = true;
          setProgress('');
          heartbeatPresence();
        }
        renderProjectButtons();
        try {
          await loadProjectWorkspace(p.id, p);
        } catch (e) {
          notice(e.message);
        }
      });
      root.append(button);
    }
  }

  async function openProjects() {
    if (!token) {
      openAccess('Сначала подключите AZRAIL.');
      return;
    }
    try {
      await ensureProjectList();
      renderProjectButtons();
      const panel = $('projectsPanel');
      if (panel) panel.hidden = false;
      const current = knownProjects.find((p) => p.id === project) || knownProjects[0];
      if (current) await loadProjectWorkspace(current.id, current);
    } catch (e) {
      notice(e.message);
    }
  }

  function closeProjects() {
    const panel = $('projectsPanel');
    if (panel) panel.hidden = true;
  }

  async function loadStudioCatalog() {
    if (studioCatalogData.length) return studioCatalogData;
    const response = await fetch('/pulse-studios.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('Не удалось загрузить каталог Studio/Labs.');
    const data = await response.json();
    studioCatalogData = Array.isArray(data.studios) ? data.studios : [];
    return studioCatalogData;
  }

  function selectCapability(item) {
    activeCapability = item;
    const name = $('capabilityName');
    const desc = $('capabilityDescription');
    const meta = $('capabilityMeta');
    const modules = $('capabilityModules');
    if (name) name.textContent = item?.title || 'Studio';
    if (desc) desc.textContent = item?.description || '';
    if (meta) meta.replaceChildren();
    if (meta && item) {
      for (const value of [String(item.kind || 'studio').toUpperCase(), String(item.mode || 'auto').toUpperCase(), String(item.status || '')]) {
        if (!value) continue;
        const pill = document.createElement('span');
        pill.className = 'catalog-pill';
        pill.textContent = value;
        meta.append(pill);
      }
    }
    if (modules) modules.replaceChildren();
    if (modules && item) {
      for (const nameValue of item.modules || []) {
        const el = document.createElement('div');
        el.className = 'catalog-module';
        el.textContent = nameValue;
        modules.append(el);
      }
    }
    for (const card of document.querySelectorAll('.catalog-card')) {
      card.classList.toggle('active', card.dataset.capability === item?.id);
    }
  }

  function renderCapabilityCatalog(kind) {
    const list = $('capabilitiesList');
    if (!list) return;
    list.replaceChildren();
    const items = (studioCatalogData || []).filter((x) => kind === 'lab' ? x.kind === 'lab' : x.kind !== 'lab');
    const title = $('capabilitiesTitle');
    if (title) title.textContent = kind === 'lab' ? 'LABS' : 'STUDIO';
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'catalog-card';
      button.dataset.capability = item.id;
      const titleEl = document.createElement('b');
      titleEl.textContent = item.title;
      const descEl = document.createElement('span');
      descEl.textContent = item.description || '';
      button.append(titleEl, descEl);
      button.addEventListener('click', () => selectCapability(item));
      list.append(button);
    }
    selectCapability(items[0] || null);
  }

  async function openCapabilityCatalog(kind) {
    try {
      await loadStudioCatalog();
      renderCapabilityCatalog(kind);
      const panel = $('capabilitiesPanel');
      if (panel) panel.hidden = false;
    } catch (e) {
      notice(e.message);
    }
  }

  function closeCapabilityCatalog() {
    const panel = $('capabilitiesPanel');
    if (panel) panel.hidden = true;
  }

  function launchCapability() {
    if (!activeCapability) return;
    if (activeCapability.mode) setMode(activeCapability.mode);
    const idea = $('idea');
    if (idea) idea.value = activeCapability.prompt || '';
    closeCapabilityCatalog();
    if (idea) idea.focus();
    notice((activeCapability.title || 'Studio') + ' подготовлена. Уточните задачу и нажмите CREATE.');
  }

  function renderMission(data) {
    const panel = $('mission');
    if (panel) panel.hidden = false;
    const missionObj = data.mission || {};
    const titleEl = $('missionTitle');
    const stateEl = $('missionState');
    if (titleEl) titleEl.textContent = missionObj.goal || missionObj.title || 'AZRAIL mission';
    if (stateEl) stateEl.textContent = (labels[missionObj.status] || missionObj.status || 'WORKING').toUpperCase();
    setProgress(missionObj.status);
    const list = $('missionSteps');
    if (list) list.replaceChildren();
    for (const step of data.plan || []) {
      const li = document.createElement('li');
      li.textContent = (step.title || 'Шаг') + ' · ' + (labels[step.status] || step.status || '');
      if (list) list.append(li);
    }
    const resultEl = $('missionResult');
    const result = data.result;
    if (resultEl) {
      resultEl.textContent = typeof result === 'string'
        ? result
        : [result?.summary, result?.error, Array.isArray(result?.questions) ? result.questions.join('\n') : null].filter(Boolean).join('\n\n');
    }
    return !!data.done;
  }

  async function poll() {
    clearTimeout(timer);
    if (!token || !mission || document.hidden) return;
    try {
      const data = await api('/api/azrail/mission?missionId=' + encodeURIComponent(mission));
      const done = renderMission(data);
      if (done) {
        setBusy(false);
        notice(data.mission?.status === 'completed' ? 'Миссия з��вершена и проверена.' : 'Миссия завершилась: ' + (labels[data.mission?.status] || data.mission?.status || 'done'));
      } else {
        setBusy(true);
        timer = setTimeout(poll, 3500);
      }
    } catch (e) {
      setBusy(false);
      if (e.status === 401) openAccess(e.message);
      else notice(e.message);
    }
  }

  function renderKeyValue(rootId, entries) {
    const root = $(rootId);
    if (!root) return;
    root.replaceChildren();
    for (const [key, value] of entries) {
      const row = document.createElement('div');
      row.className = 'advanced-row';
      const left = document.createElement('b');
      left.textContent = key;
      const right = document.createElement('span');
      right.textContent = String(value);
      row.append(left, right);
      root.append(row);
    }
    if (!entries.length) root.append(workspaceEmpty('Нет данных'));
  }

  async function openAdvanced() {
    if (!token) {
      openAccess('Сначала подключите AZRAIL.');
      return;
    }
    try {
      await ensureProjectList();
      if (!project) {
        notice('Сначала создайте проект.');
        return;
      }
      const meta = knownProjects.find((p) => p.id === project);
      const advancedProject = $('advancedProject');
      if (advancedProject) advancedProject.textContent = (meta?.name || project) + ' · live project telemetry';
      const panel = $('advancedPanel');
      if (panel) panel.hidden = false;
      const [data, permissionData] = await Promise.all([
        api('/api/azrail/observability?projectId=' + encodeURIComponent(project)),
        api('/api/azrail/projects/' + encodeURIComponent(project) + '/permissions'),
      ]);
      const observability = data.observability || {};
      const permissions = permissionData.capabilities || {};
      const models = observability.models || {};
      const budgets = observability.budgets || {};
      const runtime = observability.runtime || {};
      const routing = observability.routing || {};
      const obsCalls = $('obsCalls');
      if (obsCalls) obsCalls.textContent = String(models.calls || 0);
      const obsLatency = $('obsLatency');
      if (obsLatency) obsLatency.textContent = String(models.meanLatencyMs || 0) + ' ms';
      const obsCost = $('obsCost');
      if (obsCost) obsCost.textContent = money(models.measuredUsd || 0);
      const obsWrite = $('obsWrite');
      if (obsWrite) obsWrite.textContent = String(budgets.writesShared?.used || 0) + ' / ' + String(budgets.writesShared?.limit || 0);
      renderKeyValue('obsRuntime', [
        ['Workers plan', runtime.workersPlan || 'unknown'],
        ['Metering', runtime.metering || 'off'],
        ['AI Gateway', runtime.gatewayConfigured ? 'configured' : 'not configured'],
        ['Third-party models', routing.allowThirdPartyModels ? 'enabled' : 'disabled'],
        ['Git capability', permissions.git ? 'enabled' : 'blocked'],
        ['Deploy capability', permissions.deploy ? 'enabled' : 'blocked'],
        ['Sandbox capability', permissions.sandbox ? 'enabled' : 'blocked'],
        ['QA capability', permissions.qa ? 'enabled' : 'blocked'],
        ['Policy revision', routing.revision ?? 0],
      ]);
      renderKeyValue('obsBudgets', [
        ['Monthly limit', money(budgets.month?.limitUsd || 0)],
        ['Monthly committed', money(budgets.month?.committedUsd || 0)],
        ['Monthly remaining', money(budgets.month?.remainingUsd || 0)],
        ['Mission budgets committed', money(budgets.projectMissions?.committedUsd || 0)],
        ['Write quota remaining', String(budgets.writesShared?.remaining || 0)],
      ]);
      const missionEntries = Object.entries(observability.missions || {}).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
      renderKeyValue('obsMissions', missionEntries.map(([status, count]) => [status, String(count)]));
      const top = Array.isArray(models.top) ? models.top : [];
      renderKeyValue('obsModels', top.map((item) => [item.model || 'model', String(item.calls || 0) + ' calls · ' + money(item.measuredUsd || 0) + (item.unknownCostCalls ? ' · ' + item.unknownCostCalls + ' unknown' : '')]));
      const warning = $('obsWarning');
      if (warning) {
        const notes = [];
        if (observability.caveats?.measuredCostIncomplete) notes.push(observability.caveats.measuredCostNote || 'Measured cost is incomplete.');
        if (observability.caveats?.writeBudgetNote) notes.push(observability.caveats.writeBudgetNote);
        warning.textContent = notes.join(' ');
        warning.hidden = !notes.length;
      }
    } catch (e) {
      const panel = $('advancedPanel');
      if (panel) panel.hidden = true;
      notice(e.message);
    }
  }

  function closeAdvanced() {
    const panel = $('advancedPanel');
    if (panel) panel.hidden = true;
  }

  const composer = $('composer');
  if (composer) {
    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (busy) return;
      const idea = $('idea');
      const message = idea?.value.trim();
      if (!message) {
        notice('Опишите результат, который нужно получить.');
        return;
      }
      if (!token) {
        openAccess('Сначала подключите AZRAIL.');
        return;
      }
      setBusy(true);
      notice('Создаю проект и передаю задачу AZRAIL…');
      try {
        const projectId = await ensureProject(message);
        const key = uuid();
        const data = await api('/api/azrail/mission', { method: 'POST', key, body: { message, projectId, preferredMode: mode } });
        mission = data.missionId;
        cached('azrail_pulse_mission', mission);
        const missionPanel = $('mission');
        if (missionPanel) missionPanel.hidden = false;
        const myTitle = $('missionTitle');
        if (myTitle) myTitle.textContent = message;
        const state = $('missionState');
        if (state) state.textContent = 'ACCEPTED';
        notice('Задача принята. AZRAIL продолжит работу независимо от открытой страницы.');
        poll();
      } catch (e) {
        setBusy(false);
        if (e.status === 401) openAccess(e.message);
        else notice(e.message);
      }
    });
  }

  for (const btn of document.querySelectorAll('[data-mode]')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }
  setMode(mode);

  const studiosOpen = $('studiosOpen');
  const labsOpen = $('labsOpen');
  if (studiosOpen) studiosOpen.addEventListener('click', () => openCapabilityCatalog('studio'));
  if (labsOpen) labsOpen.addEventListener('click', () => openCapabilityCatalog('lab'));

  const studioCatalogClose = $('studioCatalogClose');
  const studioCatalog = $('studioCatalog');
  if (studioCatalogClose) studioCatalogClose.addEventListener('click', closeStudioCatalog);
  if (studioCatalog) studioCatalog.addEventListener('click', (event) => { if (event.target === studioCatalog) closeStudioCatalog(); });

  const projectsOpen = $('projectsOpen');
  if (projectsOpen) projectsOpen.addEventListener('click', openProjects);
  const projectsClose = $('projectsClose');
  if (projectsClose) projectsClose.addEventListener('click', closeProjects);
  const projectsPanel = $('projectsPanel');
  if (projectsPanel) projectsPanel.addEventListener('click', (event) => { if (event.target === projectsPanel) closeProjects(); });

  const accessConnect = $('accessConnect');
  if (accessConnect) accessConnect.addEventListener('click', connect);

  const accessClose = $('accessClose');
  if (accessClose) accessClose.addEventListener('click', closeAccess);

  const accessKey = $('accessKey');
  if (accessKey) accessKey.addEventListener('keydown', (event) => { if (event.key === 'Enter') connect(); });

  addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.data?.type !== 'pulse:globe-ready') return;
    globeReady = true;
    heartbeatPresence();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(timer);
      clearTimeout(presenceTimer);
    } else {
      if (mission) poll();
      heartbeatPresence();
    }
  });

  if (token) {
    ensureProjectList().then(() => {
      notice('AZRAIL подключён.');
      heartbeatPresence();
      if (mission) {
        setBusy(true);
        poll();
      }
    }).catch((e) => {
      if (e.status === 401) openAccess('Ключ нужно обновить или ввести заново.');
    });
  } else {
    notice('Введите задачу. При первом запуске система предложит подключить AZRAIL.');
  }

  function closeStudioCatalog() {
    const panel = $('studioCatalog');
    if (panel) panel.hidden = true;
  }
})();
