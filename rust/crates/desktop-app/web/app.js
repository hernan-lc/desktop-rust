/*
 * GitHub Desktop (Rust) — web layer.
 *
 * This file is presentation + user intent only. There is no git logic, no
 * filesystem access, no GitHub HTTP client and no persistent state here:
 * every operation goes through a `desktop.*` Rust command. State arrives as
 * immutable `state-changed` snapshots pushed from Rust.
 */
(function () {
  'use strict';

  var D = window.desktop;
  var ipc = window.ipcRenderer;
  var $ = function (id) { return document.getElementById(id); };

  var ui = {
    state: null,
    menu: null,
    data: null,
    selectedFile: null,
    selectedCommit: null,
    checked: new Set(),
    tab: 'changes',
    busy: false
  };

  var DEFAULT_MENU = [
    { id: 'file-menu', label: 'File', submenu: [
      { id: 'add-local-repository', label: 'Add Local Repository…' },
      { id: 'clone-repository', label: 'Clone Repository…' },
      { id: 'sep' },
      { id: 'show-preferences', label: 'Preferences' },
      { id: 'sep' },
      { id: 'quit-app', label: 'Quit' }
    ]},
    { id: 'repository-menu', label: 'Repository', submenu: [
      { id: 'show-changes', label: 'Changes' },
      { id: 'show-history', label: 'History' },
      { id: 'sep' },
      { id: 'fetch', label: 'Fetch origin' },
      { id: 'pull', label: 'Pull' },
      { id: 'push', label: 'Push' },
      { id: 'sep' },
      { id: 'open-working-directory', label: 'Open Working Directory' },
      { id: 'remove-repository', label: 'Remove' }
    ]},
    { id: 'branch-menu', label: 'Branch', submenu: [
      { id: 'create-branch', label: 'New Branch…' },
      { id: 'rename-branch', label: 'Rename…' },
      { id: 'delete-branch', label: 'Delete…' },
      { id: 'sep' },
      { id: 'merge-branch', label: 'Merge into Current Branch…' },
      { id: 'stash-all-changes', label: 'Stash All Changes' }
    ]},
    { id: 'view-menu', label: 'View', submenu: [
      { id: 'select-all', label: 'Select All' },
      { id: 'toggle-changes-filter', label: 'Toggle Changes Filter' },
      { id: 'sep' },
      { id: 'show-about', label: 'About GitHub Desktop' }
    ]}
  ];

  // ---------------------------------------------------------------- helpers
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function toast(message, isError) {
    var el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (isError ? ' error' : '');
    el.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { el.hidden = true; }, isError ? 6000 : 3200);
  }

  function status(message) { $('status-message').textContent = message; }

  async function call(channel, options) {
    try {
      return await D.invoke(channel, options || {});
    } catch (error) {
      toast(error.message || String(error), true);
      status('Error: ' + (error.message || error));
      throw error;
    }
  }

  async function busy(label, work) {
    ui.busy = true;
    status(label + '…');
    setButtonsDisabled(true);
    try {
      return await work();
    } finally {
      ui.busy = false;
      status('Ready');
      setButtonsDisabled(false);
    }
  }

  function repoPath() {
    var repo = selectedRepo();
    return repo ? repo.path : null;
  }

  function selectedRepo() {
    var state = ui.state;
    if (!state || !state.selectedState) { return null; }
    return state.selectedState.repository || null;
  }

  function repoName(repo) {
    if (!repo) { return ''; }
    if (repo.gitHubRepository && repo.gitHubRepository.name) { return repo.gitHubRepository.name; }
    var parts = String(repo.path).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || repo.path;
  }

  function setButtonsDisabled(disabled) {
    var hasRepo = !!selectedRepo();
    ['btn-fetch', 'btn-pull', 'btn-push', 'btn-refresh'].forEach(function (id) {
      $(id).disabled = disabled || !hasRepo;
    });
    $('branch-select').disabled = disabled || !hasRepo || !ui.data;
    $('btn-commit').disabled = disabled || !hasRepo || !$('commit-summary').value.trim();
  }

  // ---------------------------------------------------------------- state
  function onState(state) {
    ui.state = state;
    renderSidebar();
    renderHeader();
    setButtonsDisabled(false);
  }

  function renderSidebar() {
    var state = ui.state || {};
    var repos = state.repositories || [];
    var selected = selectedRepo();
    var list = $('repo-list');
    list.innerHTML = '';
    repos.forEach(function (repo) {
      var li = document.createElement('li');
      li.className = selected && selected.id === repo.id ? 'active' : '';
      var remote = repo.gitHubRepository && repo.gitHubRepository.owner
        ? repo.gitHubRepository.owner.login : '';
      li.innerHTML = '<span class="name">' + escapeHtml(repoName(repo)) + '</span>' +
        (remote ? '<span class="remote">' + escapeHtml(remote) + '</span>' : '');
      li.title = repo.path;
      li.addEventListener('click', function () { selectRepository(repo.id); });
      list.appendChild(li);
    });
    $('repo-empty').hidden = repos.length > 0;
    $('repo-count').textContent = String(repos.length);

    var accounts = state.accounts || [];
    var accountList = $('account-list');
    accountList.innerHTML = '';
    accounts.forEach(function (account) {
      var li = document.createElement('li');
      li.innerHTML = '<span>&#9679;</span><span>' + escapeHtml(account.login) + '</span>';
      li.title = account.endpoint;
      accountList.appendChild(li);
    });
  }

  function renderHeader() {
    var repo = selectedRepo();
    $('repo-name').textContent = repo ? repoName(repo) : 'No repository selected';
    $('repo-path').textContent = repo
      ? repo.path
      : 'Add or clone a repository to get started';

    var branch = ui.data && ui.data.status ? ui.data.status.currentBranch : null;
    var select = $('branch-select');
    select.innerHTML = '';
    var branches = (ui.data && ui.data.branches) || [];
    var names = branches.filter(function (b) { return String(b.type || '').toLowerCase() === 'local' || !b.name.includes('/'); })
      .map(function (b) { return b.name; });
    if (branch && names.indexOf(branch) === -1) { names.unshift(branch); }
    if (names.length === 0) { names.push(branch || 'branch'); }
    names.forEach(function (name) {
      var option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      if (name === branch) { option.selected = true; }
      select.appendChild(option);
    });

    $('commit-branch').textContent = branch || 'branch';
    $('status-branch').textContent = branch ? '&#9096; ' + branch : '';
    var ab = ui.data && ui.data.status ? ui.data.status.branchAheadBehind : null;
    $('status-ahead-behind').textContent = ab
      ? ((ab.ahead || 0) + ' ahead, ' + (ab.behind || 0) + ' behind')
      : '';
  }

  // ---------------------------------------------------------------- data
  async function refresh(silent) {
    var path = repoPath();
    if (!path) {
      ui.data = null;
      renderChanges();
      renderHistory();
      renderHeader();
      return;
    }
    var work = async function () {
      try {
        ui.data = await call('desktop.refresh-repository', { repositoryPath: path });
        renderHeader();
        renderChanges();
        renderHistory();
      } catch (_) {
        ui.data = null;
        renderChanges();
      }
    };
    if (silent) { return work(); }
    return busy('Refreshing repository', work);
  }

  async function selectRepository(id) {
    await call('desktop.select-repository', { id: id });
    ui.selectedFile = null;
    ui.selectedCommit = null;
    ui.checked.clear();
    await refresh();
  }

  function renderChanges() {
    var status = ui.data && ui.data.status;
    var files = (status && status.workingDirectoryFiles) || [];
    var list = $('file-list');
    list.innerHTML = '';
    files.forEach(function (file) {
      var li = document.createElement('li');
      if (ui.selectedFile === file.path) { li.className = 'active'; }
      var kind = (file.status || 'modified').toLowerCase();
      var glyph = { new: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', conflicted: 'U' }[kind] || 'M';
      var checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = ui.checked.has(file.path);
      checkbox.addEventListener('change', function (event) {
        event.stopPropagation();
        if (checkbox.checked) { ui.checked.add(file.path); }
        else { ui.checked.delete(file.path); }
        updateCommitButton();
      });
      var pill = document.createElement('span');
      pill.className = 'status-pill status-' + kind;
      pill.textContent = glyph;
      var path = document.createElement('span');
      path.className = 'path';
      path.textContent = file.path;
      path.title = file.path;
      li.appendChild(checkbox);
      li.appendChild(pill);
      li.appendChild(path);
      li.addEventListener('click', function () { openDiff(file.path); });
      list.appendChild(li);
    });

    $('changes-count').textContent = String(files.length);
    $('file-pane-title').textContent = files.length + ' changed file' + (files.length === 1 ? '' : 's');
    $('changes-empty').hidden = files.length > 0;
    $('btn-discard').hidden = ui.checked.size === 0;
    $('select-all-files').checked = files.length > 0 && ui.checked.size === files.length;
    updateCommitButton();
  }

  function updateCommitButton() {
    var summary = $('commit-summary').value.trim();
    $('btn-commit').disabled = !summary || !selectedRepo() || ui.busy;
  }

  async function openDiff(path) {
    ui.selectedFile = path;
    renderChanges();
    $('diff-header').textContent = path;
    $('diff-content').innerHTML = '<span class="placeholder">Loading diff…</span>';
    try {
      var diff = await call('desktop.get-diff', { path: path, repositoryPath: repoPath() });
      renderDiff(diff);
    } catch (_) {
      $('diff-content').innerHTML = '<span class="placeholder">Unable to load diff.</span>';
    }
  }

  function renderDiff(diff) {
    var container = $('diff-content');
    container.textContent = '';
    if (!diff) {
      container.innerHTML = '<span class="placeholder">No diff available.</span>';
      return;
    }
    if (diff.isBinary) {
      container.innerHTML = '<span class="placeholder">Binary file.</span>';
      return;
    }
    if (diff.text) {
      container.textContent = diff.text;
      return;
    }
    var hunks = diff.hunks || [];
    if (hunks.length === 0) {
      container.innerHTML = '<span class="placeholder">No textual changes (the file may be untracked).</span>';
      return;
    }
    hunks.forEach(function (hunk) {
      (hunk.lines || []).forEach(function (line) {
        var span = document.createElement('span');
        var kind = line.type || 'context';
        span.className = kind === 'add' ? 'diff-add'
          : kind === 'delete' ? 'diff-del'
          : kind === 'hunk' ? 'diff-hunk' : '';
        var prefix = kind === 'add' ? '+' : kind === 'delete' ? '-' : ' ';
        span.textContent = prefix + line.text + '\n';
        container.appendChild(span);
      });
    });
  }

  function renderHistory() {
    var commits = (ui.data && ui.data.commits) || [];
    var list = $('commit-list');
    list.innerHTML = '';
    commits.forEach(function (commit) {
      var li = document.createElement('li');
      if (ui.selectedCommit && ui.selectedCommit.sha === commit.sha) { li.className = 'active'; }
      var author = commit.author ? commit.author.name : '';
      li.innerHTML = '<div class="commit-summary">' + escapeHtml(commit.summary) + '</div>' +
        '<div class="commit-meta"><span class="commit-sha">' + escapeHtml(commit.shortSha) + '</span>' +
        '<span>' + escapeHtml(author) + '</span></div>';
      li.addEventListener('click', function () { openCommit(commit); });
      list.appendChild(li);
    });
    if (commits.length === 0) {
      list.innerHTML = '<li class="empty-hint">No commits yet.</li>';
    }
  }

  async function openCommit(commit) {
    ui.selectedCommit = commit;
    renderHistory();
    var body = $('commit-detail-body');
    var author = commit.author || {};
    body.innerHTML = '<h3>' + escapeHtml(commit.summary) + '</h3>' +
      '<div class="meta">' + escapeHtml(author.name || '') + ' &lt;' + escapeHtml(author.email || '') + '&gt; · ' +
      escapeHtml(author.date || '') + ' · ' + escapeHtml(commit.sha) + '</div>' +
      (commit.body ? '<pre class="selectable">' + escapeHtml(commit.body) + '</pre>' : '') +
      '<div class="section-title">Changed files</div><ul id="commit-files" class="changed-file-list"><li>Loading…</li></ul>';
    try {
      var files = await call('desktop.get-changed-files', { sha: commit.sha, repositoryPath: repoPath() });
      var ul = $('commit-files');
      if (!ul) { return; }
      ul.innerHTML = '';
      (files || []).forEach(function (file) {
        var li = document.createElement('li');
        li.textContent = file.path + '  +' + (file.additions || 0) + ' -' + (file.deletions || 0);
        ul.appendChild(li);
      });
      if (!files || files.length === 0) { ul.innerHTML = '<li>No changed files.</li>'; }
    } catch (_) { /* error already surfaced by call() */ }
  }

  // ---------------------------------------------------------------- menu
  function renderMenu(model) {
    ui.menu = model;
    var items = model && model.items && model.items.length ? model.items : DEFAULT_MENU;
    var bar = $('menubar');
    bar.innerHTML = '';
    items.forEach(function (entry) {
      if (!entry || entry.visible === false) { return; }
      var root = document.createElement('div');
      root.className = 'menu-root';
      var trigger = document.createElement('button');
      trigger.className = 'menu-trigger';
      trigger.textContent = entry.label || entry.id;
      var dropdown = document.createElement('div');
      dropdown.className = 'menu-dropdown';
      dropdown.hidden = true;
      (entry.submenu || []).forEach(function (child) {
        if (child.id === 'sep' || child.type === 'separator') {
          var sep = document.createElement('div');
          sep.className = 'menu-separator';
          dropdown.appendChild(sep);
          return;
        }
        var button = document.createElement('button');
        button.textContent = child.label || child.id;
        button.disabled = child.enabled === false;
        button.addEventListener('click', function () {
          dropdown.hidden = true;
          root.classList.remove('open');
          handleMenuEvent(child.id);
        });
        dropdown.appendChild(button);
      });
      trigger.addEventListener('click', function (event) {
        event.stopPropagation();
        var willOpen = dropdown.hidden;
        document.querySelectorAll('.menu-dropdown').forEach(function (d) { d.hidden = true; });
        document.querySelectorAll('.menu-root').forEach(function (r) { r.classList.remove('open'); });
        dropdown.hidden = !willOpen;
        root.classList.toggle('open', willOpen);
      });
      root.appendChild(trigger);
      root.appendChild(dropdown);
      bar.appendChild(root);
    });
  }

  document.addEventListener('click', function () {
    document.querySelectorAll('.menu-dropdown').forEach(function (d) { d.hidden = true; });
    document.querySelectorAll('.menu-root').forEach(function (r) { r.classList.remove('open'); });
  });

  async function handleMenuEvent(id) {
    if (!id) { return; }
    switch (id) {
      case 'quit-app': return D.send('quit-app');
      case 'add-local-repository': return addRepositoryDialog();
      case 'clone-repository': return cloneDialog();
      case 'create-repository': return toast('Use your shell or GitHub.com to create a new repository, then add it locally.');
      case 'show-preferences': return preferencesDialog();
      case 'show-about': return aboutDialog();
      case 'show-changes': return switchTab('changes');
      case 'show-history': return switchTab('history');
      case 'show-branches': return switchTab('history');
      case 'fetch': return doFetch();
      case 'pull': return doPull();
      case 'push': return doPush();
      case 'select-all': return D.send('select-all-window-contents');
      case 'create-branch': return branchDialog();
      case 'open-working-directory': return openWorkingDirectory();
      case 'remove-repository': return removeRepository();
      case 'stash-all-changes': return gitAction('desktop.create-stash', {}, 'Stashing changes');
      default:
        // Unknown ids are still forwarded so Rust can emit them for other UI.
        return D.send('execute-menu-item-by-id', id);
    }
  }

  function switchTab(tab) {
    ui.tab = tab;
    $('view-changes').hidden = tab !== 'changes';
    $('view-history').hidden = tab !== 'history';
    $('tab-changes').classList.toggle('active', tab === 'changes');
    $('tab-history').classList.toggle('active', tab === 'history');
    $('tab-changes').setAttribute('aria-selected', String(tab === 'changes'));
    $('tab-history').setAttribute('aria-selected', String(tab === 'history'));
  }

  // ---------------------------------------------------------------- actions
  async function gitAction(channel, options, label) {
    if (!selectedRepo()) { return toast('Select a repository first', true); }
    await busy(label, async function () {
      var result = await call(channel, Object.assign({ repositoryPath: repoPath() }, options));
      if (result && result.exitCode && result.exitCode !== 0) {
        toast((result.stderr || 'git command failed').trim(), true);
      } else {
        toast(label + ' complete');
      }
      await refresh(true);
    });
  }

  function doFetch() { return gitAction('desktop.fetch', {}, 'Fetching'); }
  function doPull() { return gitAction('desktop.pull', {}, 'Pulling'); }
  function doPush() { return gitAction('desktop.push', {}, 'Pushing'); }

  async function openWorkingDirectory() {
    var path = repoPath();
    if (!path) { return; }
    await call('open-external', path);
  }

  async function removeRepository() {
    var repo = selectedRepo();
    if (!repo) { return; }
    var answer = await call('desktop.show-message-box', {
      message: 'Remove ' + repoName(repo) + '?',
      detail: 'The repository will be removed from GitHub Desktop. Files on disk are untouched.',
      buttons: ['Remove', 'Cancel'], defaultId: 0, cancelId: 1
    });
    if (answer === 0) {
      await call('desktop.remove-repository', { id: repo.id });
      await refresh(true);
    }
  }

  async function commit() {
    var summary = $('commit-summary').value.trim();
    if (!summary) { return; }
    var paths = Array.from(ui.checked);
    await busy('Committing', async function () {
      if (paths.length > 0) {
        await call('desktop.stage', { paths: paths, repositoryPath: repoPath() });
      }
      await call('desktop.commit', {
        summary: summary,
        body: $('commit-body').value,
        repositoryPath: repoPath()
      });
      $('commit-summary').value = '';
      $('commit-body').value = '';
      ui.checked.clear();
      await refresh(true);
      toast('Commit created');
    });
  }

  // ---------------------------------------------------------------- modals
  function openModal(title, html, onReady) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = html;
    $('modal-root').hidden = false;
    if (onReady) { onReady($('modal-body')); }
  }

  function closeModal() { $('modal-root').hidden = true; }

  function field(label, id, type, placeholder, value) {
    return '<div class="field"><label for="' + id + '">' + escapeHtml(label) + '</label>' +
      '<input id="' + id + '" type="' + type + '" placeholder="' + escapeHtml(placeholder || '') +
      '" value="' + escapeHtml(value || '') + '" /></div>';
  }

  function actions(okLabel, onOk) {
    return function (body) {
      var cancel = body.querySelector('[data-cancel]');
      var ok = body.querySelector('[data-ok]');
      if (cancel) { cancel.addEventListener('click', closeModal); }
      if (ok) {
        ok.addEventListener('click', async function () {
          try { await onOk(body, ok); }
          catch (error) { /* surfaced by call() */ }
        });
      }
      var first = body.querySelector('input');
      if (first) { first.focus(); }
    };
  }

  function modalFooter(okLabel) {
    return '<div class="modal-actions">' +
      '<button class="btn" data-cancel>Cancel</button>' +
      '<button class="btn btn-primary" data-ok>' + escapeHtml(okLabel || 'OK') + '</button></div>';
  }

  async function pickFolder() {
    var result = await call('show-open-dialog', { properties: ['openDirectory'] });
    if (!result || result.canceled || !result.filePaths || !result.filePaths.length) { return null; }
    return result.filePaths[0];
  }

  function addRepositoryDialog() {
    openModal('Add a local repository',
      field('Repository path', 'dlg-path', 'text', 'C:\\Users\\me\\src\\repo') +
      '<p class="hint">Choose an existing Git repository on this machine. ' +
      'The path is validated by Rust before it is added.</p>' +
      '<div class="modal-actions"><button class="btn" id="dlg-browse">Browse…</button>' +
      '<span style="flex:1"></span><button class="btn" data-cancel>Cancel</button>' +
      '<button class="btn btn-primary" data-ok>Add repository</button></div>',
      function (body) {
        body.querySelector('[data-cancel]').addEventListener('click', closeModal);
        body.querySelector('#dlg-browse').addEventListener('click', async function () {
          var path = await pickFolder();
          if (path) { body.querySelector('#dlg-path').value = path; }
        });
        body.querySelector('[data-ok]').addEventListener('click', async function () {
          var path = body.querySelector('#dlg-path').value.trim();
          if (!path) { return toast('Enter a path', true); }
          var result = await call('desktop.add-repository', { path: path });
          closeModal();
          toast(result.added ? 'Repository added' : 'Repository already added');
          await refresh();
        });
      });
  }

  function cloneDialog() {
    openModal('Clone a repository',
      field('Repository URL', 'dlg-url', 'text', 'https://github.com/owner/repo.git') +
      field('Local path', 'dlg-path', 'text', 'C:\\Users\\me\\src\\repo') +
      '<p class="hint">Cloning uses the Rust git engine; no Node or dugite process runs in the webview.</p>' +
      modalFooter('Clone'),
      actions('Clone', async function (body) {
        var url = body.querySelector('#dlg-url').value.trim();
        var path = body.querySelector('#dlg-path').value.trim();
        if (!url || !path) { return toast('URL and path are required', true); }
        await busy('Cloning', async function () {
          await call('desktop.clone', { url: url, path: path });
          closeModal();
          toast('Clone complete');
          await refresh(true);
        });
      }));
  }

  function branchDialog() {
    var current = $('branch-select').value;
    openModal('Create a branch',
      field('Branch name', 'dlg-branch', 'text', 'my-feature') +
      '<p class="hint">Creates the branch from <strong>' + escapeHtml(current) + '</strong> and checks it out.</p>' +
      modalFooter('Create branch'),
      actions('Create', async function (body) {
        var name = body.querySelector('#dlg-branch').value.trim();
        if (!name) { return toast('Enter a branch name', true); }
        await gitAction('desktop.create-branch', { name: name, startPoint: current }, 'Creating branch');
        closeModal();
      }));
  }

  function signInDialog() {
    openModal('Sign in to GitHub',
      field('Username', 'dlg-login', 'text', 'octocat') +
      field('Personal access token', 'dlg-token', 'password', 'ghp_…') +
      field('API endpoint (optional)', 'dlg-endpoint', 'text', 'https://api.github.com') +
      '<p class="hint">The token is stored by Rust in a DPAPI-protected credential file. ' +
      'It is never serialized into the state snapshot sent to the webview.</p>' +
      modalFooter('Sign in'),
      actions('Sign in', async function (body) {
        var login = body.querySelector('#dlg-login').value.trim();
        var token = body.querySelector('#dlg-token').value.trim();
        var endpoint = body.querySelector('#dlg-endpoint').value.trim();
        if (!token) { return toast('A token is required', true); }
        var options = { token: token, login: login || undefined };
        if (endpoint) { options.endpoint = endpoint; }
        await busy('Signing in', async function () {
          await call('desktop.sign-in', options);
          closeModal();
          toast('Signed in');
        });
      }));
  }

  function preferencesDialog() {
    var prefs = (ui.state && ui.state.preferences) || {};
    openModal('Preferences',
      '<div class="field"><label><input type="checkbox" id="pref-confirm-discard" ' +
      (prefs.confirmDiscardChanges !== false ? 'checked' : '') + '/> Confirm discarding changes</label></div>' +
      '<div class="field"><label><input type="checkbox" id="pref-repo-indicators" ' +
      (prefs.repositoryIndicatorsEnabled !== false ? 'checked' : '') + '/> Show repository indicators</label></div>' +
      field('Tab size', 'pref-tab-size', 'number', '4', prefs.tabSize || 4) +
      '<div class="field"><label for="pref-theme">Theme</label><select id="pref-theme">' +
      '<option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option>' +
      '</select></div>' +
      '<p class="hint">Preferences are persisted by Rust as JSON under the application data directory.</p>' +
      modalFooter('Save'),
      actions('Save', async function (body) {
        await call('desktop.set-preference', { key: 'confirmDiscardChanges', value: body.querySelector('#pref-confirm-discard').checked });
        await call('desktop.set-preference', { key: 'repositoryIndicatorsEnabled', value: body.querySelector('#pref-repo-indicators').checked });
        await call('desktop.set-preference', { key: 'tabSize', value: Number(body.querySelector('#pref-tab-size').value) || 4 });
        D.send('set-native-theme-source', body.querySelector('#pref-theme').value);
        closeModal();
        toast('Preferences saved');
      }));
  }

  function aboutDialog() {
    openModal('About GitHub Desktop (Rust)',
      '<p class="hint" style="font-size:12px">' +
      'A migration of GitHub Desktop from Electron to a pure-Rust application shell.<br/><br/>' +
      '<strong>Windowing:</strong> tao &nbsp;·&nbsp; <strong>WebView:</strong> wry<br/>' +
      '<strong>Backend:</strong> desktop-core (git, storage, API, state, IPC)<br/>' +
      '<strong>Frontend:</strong> HTML / CSS / JavaScript served from <code>desktop://</code><br/><br/>' +
      'No Tauri runtime, no Electron, no Node integration.' +
      '</p><div id="about-info" class="hint">Loading…</div>' +
      '<div class="modal-actions"><button class="btn btn-primary" data-cancel>Close</button></div>',
      async function (body) {
        body.querySelector('[data-cancel]').addEventListener('click', closeModal);
        try {
          var info = await D.invoke('desktop.get-app-info');
          body.querySelector('#about-info').textContent =
            'Version ' + info.version + ' · Git ' + info.git + ' · ' + info.userData;
        } catch (_) { /* ignore */ }
      });
  }

  function contextMenu(payload) {
    var items = payload && payload.items ? payload.items : [];
    if (!items.length) { return; }
    var existing = document.getElementById('web-context-menu');
    if (existing) { existing.remove(); }
    var menu = document.createElement('div');
    menu.id = 'web-context-menu';
    menu.className = 'menu-dropdown';
    menu.style.position = 'fixed';
    menu.style.left = '20px';
    menu.style.top = '60px';
    items.forEach(function (item) {
      if (item.type === 'separator') { return; }
      var button = document.createElement('button');
      button.textContent = item.label || item.id;
      button.disabled = item.enabled === false;
      button.addEventListener('click', function () {
        menu.remove();
        handleMenuEvent(item.id);
      });
      menu.appendChild(button);
    });
    document.body.appendChild(menu);
    var dismiss = function () { menu.remove(); document.removeEventListener('click', dismiss); };
    setTimeout(function () { document.addEventListener('click', dismiss); }, 0);
  }

  // ---------------------------------------------------------------- wiring
  function wire() {
    $('tab-changes').addEventListener('click', function () { switchTab('changes'); });
    $('tab-history').addEventListener('click', function () { switchTab('history'); });
    $('btn-refresh').addEventListener('click', function () { refresh(); });
    $('btn-add-repo').addEventListener('click', addRepositoryDialog);
    $('btn-clone').addEventListener('click', cloneDialog);
    $('btn-signin').addEventListener('click', signInDialog);
    $('btn-preferences').addEventListener('click', preferencesDialog);
    $('btn-about').addEventListener('click', aboutDialog);
    $('btn-fetch').addEventListener('click', doFetch);
    $('btn-pull').addEventListener('click', doPull);
    $('btn-push').addEventListener('click', doPush);
    $('btn-commit').addEventListener('click', commit);
    $('commit-summary').addEventListener('input', updateCommitButton);
    $('commit-summary').addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { commit(); }
    });
    $('modal-close').addEventListener('click', closeModal);
    $('modal-root').querySelector('[data-close]').addEventListener('click', closeModal);
    $('win-minimize').addEventListener('click', function () { D.send('minimize-window'); });
    $('win-maximize').addEventListener('click', function () { D.send('maximize-window'); });
    $('win-close').addEventListener('click', function () { D.send('close-window'); });

    $('branch-select').addEventListener('change', function (event) {
      gitAction('desktop.checkout-branch', { name: event.target.value }, 'Checking out');
    });
    $('select-all-files').addEventListener('change', function (event) {
      ui.checked.clear();
      if (event.target.checked) {
        var files = (ui.data && ui.data.status && ui.data.status.workingDirectoryFiles) || [];
        files.forEach(function (file) { ui.checked.add(file.path); });
      }
      renderChanges();
    });
    $('btn-discard').addEventListener('click', function () {
      gitAction('desktop.discard-changes', { paths: Array.from(ui.checked) }, 'Discarding changes');
      ui.checked.clear();
    });
  }

  // ---------------------------------------------------------------- events
  ipc.on('state-changed', function (_event, state) { onState(state); });
  ipc.on('app-menu', function (_event, menu) { renderMenu(menu); });
  ipc.on('menu-event', function (_event, id) { handleMenuEvent(id); });
  ipc.on('context-menu', function (_event, payload) { contextMenu(payload); });
  ipc.on('focus', function () { document.body.classList.remove('blurred'); });
  ipc.on('blur', function () { document.body.classList.add('blurred'); });
  ipc.on('error', function (_event, detail) {
    var message = detail && (detail.message || (detail.error && detail.error.message));
    if (message) { toast(message, true); }
  });
  ipc.on('auto-updater-error', function (_event, message) { toast('Update error: ' + message, true); });
  ipc.on('zoom-factor-changed', function (_event, factor) {
    document.body.style.zoom = String(factor || 1);
  });
  ipc.on('native-theme-updated', function () { /* CSS media query handles the palette */ });
  ipc.on('window-state-changed', function (_event, state) { status('Window: ' + state); });
  ipc.on('cli-action', function (_event, action) {
    if (!action) { return; }
    if (action.kind === 'open-repository' && action.path) {
      call('desktop.add-repository', { path: action.path }).then(function () { return refresh(); });
    } else if (action.kind === 'clone-url') {
      toast('Clone requested: ' + action.url);
    }
  });
  ipc.on('url-action', function (_event, action) { toast('URL action: ' + (action && action.kind)); });
  ipc.on('launch-timing-stats', function (_event, stats) {
    if (stats && stats.loadTime) { status('Ready in ' + Math.round(stats.loadTime) + ' ms'); }
  });

  // ---------------------------------------------------------------- startup
  async function start() {
    wire();
    renderMenu(ui.menu);
    D.ready(); // flush events emitted before the UI subscribed
    D.send('renderer-ready', performance.now());

    try {
      var state = await D.invoke('desktop.get-state');
      onState(state);
    } catch (error) {
      toast('Unable to load initial state: ' + error.message, true);
    }
    try {
      await refresh(true);
    } catch (_) { /* no repository selected yet */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
