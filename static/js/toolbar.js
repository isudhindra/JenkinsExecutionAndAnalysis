// Toolbar actions: rerun jobs, failure consolidation view, CSV export, keyboard shortcuts.
'use strict';

// == RERUN OPERATIONS ==
function _scopedJobsForRerun() {
    const scope = (typeof getActionScope === 'function') ? getActionScope() : null;
    if (!scope) return Array.from(appState.jobs.values());
    return scope.jobIds.map(id => appState.jobs.get(id)).filter(Boolean);
}

async function triggerRerunAllFailed() {
    // "Rerun Failed" respects the action scope
    const source = _scopedJobsForRerun();
    const failed = source
        .filter(job => job.latest_status === 'FAILURE')
        .map(job => job.job_id);

    if (failed.length === 0) {
        showToast('No failed jobs in current scope to rerun', 'info');
        return;
    }
    const scope = (typeof getActionScope === 'function') ? getActionScope() : { label: 'all' };
    const suffix = scope.label !== 'all' ? ` (${scope.label})` : '';
    showToast(`Rerunning ${failed.length} failed job${failed.length === 1 ? '' : 's'}${suffix}…`, 'info');
    triggerRerun(failed);
}

function triggerRerunSelected() {
    if (appState.selectedJobs.size === 0) {
        showToast('No jobs selected', 'info');
        return;
    }
    const n = appState.selectedJobs.size;
    showToast(`Rerunning ${n} selected job${n === 1 ? '' : 's'}…`, 'info');
    triggerRerun(Array.from(appState.selectedJobs));
}

function triggerRerunByStatus(status) {
    // Same scope rule — narrows by filter/selection first, then by status.
    const source = _scopedJobsForRerun();
    const matching = source
        .filter(job => job.latest_status === status)
        .map(job => job.job_id);
    if (matching.length === 0) {
        showToast('No ' + status.toLowerCase() + ' jobs in current scope to rerun', 'info');
        return;
    }
    const scope = (typeof getActionScope === 'function') ? getActionScope() : { label: 'all' };
    const suffix = scope.label !== 'all' ? ` (${scope.label})` : '';
    showToast(
        `Rerunning ${matching.length} ${status.toLowerCase()} job${matching.length === 1 ? '' : 's'}${suffix}…`,
        'info',
    );
    triggerRerun(matching);
}

// == DYNAMIC TOOLBAR ACTION VISIBILITY ==

// Show/hide buttons and update count badges based on what's in view.
function updateToolbarActions() {
    const visibleJobs = getVisibleJobs();
    const hasFailed = visibleJobs.some(j => j.latest_status === 'FAILURE');
    const hasUnstable = visibleJobs.some(j => j.latest_status === 'UNSTABLE');
    const hasAborted = visibleJobs.some(j => j.latest_status === 'ABORTED');
    const selectedCount = appState.selectedJobs.size;
    const hasSelected = selectedCount > 0;

    const showHide = (id, condition) => {
        const el = document.getElementById(id);
        if (el) el.style.display = condition ? '' : 'none';
    };
    // "Refresh Failed" / "Refresh Unstable" / "Refresh Aborted" stay visible
    // when zero candidates remain — disabled with a tooltip so the sign-off
    // ritual ("I clicked it and got 0") still has an affordance.
    const setRefreshState = (id, ok, label) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = '';
        el.disabled = !ok;
        if (!ok) el.title = `No ${label} jobs in current scope`;
        else el.title = '';
    };
    setRefreshState('ops-refresh-failed', hasFailed, 'failed');
    setRefreshState('ops-refresh-unstable', hasUnstable, 'unstable');
    setRefreshState('ops-refresh-aborted', hasAborted, 'aborted');
    showHide('ops-refresh-selected', hasSelected);
    showHide('ops-refresh-sel-divider', hasSelected);

    const refreshSelCount = document.getElementById('ops-refresh-sel-count');
    if (refreshSelCount) refreshSelCount.textContent = hasSelected ? selectedCount : '';

    showHide('ops-rerun-failed', hasFailed);
    showHide('ops-rerun-unstable', hasUnstable);
    showHide('ops-rerun-aborted', hasAborted);
    showHide('ops-rerun-selected', hasSelected);
    showHide('ops-rerun-sel-divider', hasSelected && (hasFailed || hasUnstable || hasAborted));

    const countBadge = document.getElementById('ops-selected-count');
    if (countBadge) countBadge.textContent = hasSelected ? selectedCount : '';

    const anyRerun = hasFailed || hasUnstable || hasAborted || hasSelected;
    showHide('ops-rerun-dropdown', anyRerun);
    const sepRerun = document.getElementById('ops-sep-rerun');
    if (sepRerun) sepRerun.style.display = anyRerun ? '' : 'none';

    // Failures button stays in a permanent slot 
    const failBtn = document.getElementById('ops-failure-view');
    if (failBtn) {
        const inFailureView = (typeof _failureViewActive !== 'undefined') && _failureViewActive;
        
        let failCount;
        if (inFailureView && window.appState && appState.jobs) {
            failCount = Array.from(appState.jobs.values())
                .filter(j => j.latest_status === 'FAILURE' || j.latest_status === 'UNSTABLE').length;
        } else {
            failCount = visibleJobs.filter(j => j.latest_status === 'FAILURE' || j.latest_status === 'UNSTABLE').length;
        }
        const fcBadge = document.getElementById('ops-failure-count');
        if (fcBadge) fcBadge.textContent = failCount;
        const isEmpty = failCount === 0;
        failBtn.classList.toggle('is-empty', isEmpty && !inFailureView);
        failBtn.disabled = isEmpty && !inFailureView;
        failBtn.setAttribute('aria-disabled', (isEmpty && !inFailureView) ? 'true' : 'false');
    }
}

// Open a dropdown, closing any others. Keeps aria-expanded in sync for screen readers.
function toggleOpsDropdown(dropdownId) {
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    const wasOpen = dropdown.classList.contains('open');
    closeOpsDropdowns();
    if (!wasOpen) {
        dropdown.classList.add('open');
        _setAriaExpandedFor(dropdown, true);
    }
}

function closeOpsDropdowns() {
    document.querySelectorAll('.ops-dropdown.open').forEach(d => {
        d.classList.remove('open');
        _setAriaExpandedFor(d, false);
    });
}

// Flip aria-expanded on the dropdown's trigger button(s) — split buttons
// have two, but only the caret carries the attribute.
function _setAriaExpandedFor(container, isOpen) {
    container.querySelectorAll('[aria-haspopup="menu"]').forEach(btn => {
        btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    });
}

// Click outside any dropdown closes them all.
document.addEventListener('click', function(e) {
    if (!e.target.closest('.ops-dropdown')) closeOpsDropdowns();
});

// Keyboard shortcuts: `/` focuses search, `r` refreshes, `s` toggles view mode,
// Escape closes dropdowns. Alpha shortcuts are suppressed while typing in a field.
document.addEventListener('keydown', function(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (e.key === 'Escape') {
        closeOpsDropdowns();
        return;
    }

    const t = e.target;
    const isTyping = t && (
        t.tagName === 'INPUT' ||
        t.tagName === 'TEXTAREA' ||
        t.tagName === 'SELECT' ||
        (t.isContentEditable === true)
    );

    if (e.key === '/' && !isTyping) {
        const search = document.getElementById('filter-search');
        if (search) {
            e.preventDefault();
            search.focus();
            search.select();
        }
        return;
    }

    if (isTyping) return;

    if (e.key === 'r' || e.key === 'R') {
        if (typeof handleRefreshAction === 'function') {
            e.preventDefault();
            handleRefreshAction('all');
        }
    } else if (e.key === 's' || e.key === 'S') {
        if (typeof switchViewMode === 'function' && typeof appState !== 'undefined') {
            e.preventDefault();
            switchViewMode(appState.viewMode === 'detail' ? 'summary' : 'detail');
        }
    }
});

// == FAILURE CONSOLIDATION VIEW ==

let _fvSearchDebounce = null;
let _failureViewActive = false;

// Disable job-table-only controls while in failure view; restore on return.
// Remembers each control's pre-disable state so we don't re-enable something
// that was already disabled.
function setToolbarViewState(mode) {
    var isFailures = (mode === 'failures');
    var targets = document.querySelectorAll('[data-fv-disable]');
    targets.forEach(function(el) {
        if (isFailures) {
            el.classList.add('fv-toolbar-disabled');
            el.querySelectorAll('button, select, input').forEach(function(ctrl) {
                ctrl.dataset.fvWasDisabled = ctrl.disabled ? '1' : '';
                ctrl.disabled = true;
            });
            if (el.matches('button, select, input')) {
                el.dataset.fvWasDisabled = el.disabled ? '1' : '';
                el.disabled = true;
            }
        } else {
            el.classList.remove('fv-toolbar-disabled');
            el.querySelectorAll('button, select, input').forEach(function(ctrl) {
                if (ctrl.dataset.fvWasDisabled !== '1') {
                    ctrl.disabled = false;
                }
                delete ctrl.dataset.fvWasDisabled;
            });
            if (el.matches('button, select, input')) {
                if (el.dataset.fvWasDisabled !== '1') {
                    el.disabled = false;
                }
                delete el.dataset.fvWasDisabled;
            }
        }
    });
    if (isFailures && typeof closeOpsDropdowns === 'function') {
        closeOpsDropdowns();
    }
}

// Build one entry per failed/unstable job, with deduped error summary
function collectFailureEntries() {
    var entries = [];
    var scope = (typeof getActionScope === 'function') ? getActionScope() : null;
    var scopedSet = (scope && scope.label !== 'all') ? new Set(scope.jobIds) : null;

    appState.jobs.forEach(function(job, jobId) {
        if (scopedSet && !scopedSet.has(jobId)) return;
        var st = job.latest_status;
        if (st !== 'FAILURE' && st !== 'UNSTABLE') return;

        var cls = job.classification || {};
        var fe = job.failure_evidence || {};
        var execTime = job.last_execution_time || '';
        var jobName = job.name || job.job_name || jobId;
        var jobUrl = job.url || job.job_url || jobId;

        var errorLogs = fe.error_logs || [];

        if (errorLogs.length > 0 && typeof clvIsErrorNoise === 'function') {
            errorLogs = errorLogs.filter(function(errEntry) {
                var msg = errEntry.message || '';
                var level = errEntry.level || 'ERROR';
                // Match against both the raw message
                return !(clvIsErrorNoise(msg) || clvIsErrorNoise(level + ': ' + msg));
            });
        }

        var errorItems = [];     // expanded detail panel rows
        var uniqueErrors = [];   // deduped short messages for the collapsed row
        var rawTextParts = [];   // every error string concatenated for search

        if (errorLogs.length > 0) {
            var seenMsg = {};
            errorLogs.forEach(function(errEntry) {
                var msg = errEntry.message || 'No message';
                var level = errEntry.level || 'ERROR';
                var lineNum = errEntry.line_number || null;
                var ctx = errEntry.context_before || '';

                var detail = '';
                if (ctx) detail += ctx + '\n';
                detail += (lineNum ? '[Line ' + lineNum + '] ' : '') + level + ': ' + msg;

                errorItems.push({ message: msg, level: level, lineNumber: lineNum, detail: detail });
                rawTextParts.push(detail);

                // Dedup on first 80 chars so trivial differences collapse together.
                var key = msg.substring(0, 80).toLowerCase();
                if (!seenMsg[key]) {
                    seenMsg[key] = { msg: msg, count: 1 };
                    uniqueErrors.push(seenMsg[key]);
                } else {
                    seenMsg[key].count++;
                }
            });
        } else {
            // No structured logs — best-effort fallback from classification snippets.
            var snippet = cls.evidence_snippet || fe.failure_context || cls.action || 'No detailed error information available';
            errorItems.push({ message: snippet, level: 'INFO', lineNumber: null, detail: snippet });
            uniqueErrors.push({ msg: snippet, count: 1 });
            rawTextParts.push(snippet);
        }

        var errorSummary = uniqueErrors.map(function(e) {
            return e.count > 1 ? e.msg + ' (\u00d7' + e.count + ')' : e.msg;
        }).join('\n');

        var searchBlob = [jobName, errorSummary].concat(rawTextParts).join(' ').toLowerCase();

        entries.push({
            jobId: jobId,
            jobName: jobName,
            jobUrl: jobUrl,
            status: st,
            errorCount: errorLogs.length || 1,
            errorSummary: errorSummary,
            errorItems: errorItems,
            execTime: execTime,
            searchBlob: searchBlob
        });
    });

    // Sort: FAILURE before UNSTABLE, then by error count desc, then alpha by name.
    entries.sort(function(a, b) {
        if (a.status !== b.status) return a.status === 'FAILURE' ? -1 : 1;
        if (b.errorCount !== a.errorCount) return b.errorCount - a.errorCount;
        return a.jobName.localeCompare(b.jobName);
    });
    return entries;
}

// Per-entry error filter.
function _fvApplyErrorFilter(entry, term) {
    if (!term) return entry;
    var t = term.toLowerCase();
    var jobNameMatch = (entry.jobName || '').toLowerCase().indexOf(t) !== -1;
    var matched = entry.errorItems.filter(function(it) {
        return (it.detail || '').toLowerCase().indexOf(t) !== -1
            || (it.message || '').toLowerCase().indexOf(t) !== -1;
    });
    if (matched.length === 0) return jobNameMatch ? entry : null;
    // Rebuild dedup summary from the filtered items only.
    var seen = {};
    var unique = [];
    matched.forEach(function(it) {
        var key = (it.message || '').substring(0, 80).toLowerCase();
        if (!seen[key]) { seen[key] = { msg: it.message, count: 1 }; unique.push(seen[key]); }
        else seen[key].count++;
    });
    var errorSummary = unique.map(function(u) {
        return u.count > 1 ? u.msg + ' (\u00D7' + u.count + ')' : u.msg;
    }).join('\n');
    return Object.assign({}, entry, {
        errorItems: matched,
        errorCount: matched.length,
        errorSummary: errorSummary,
        _fvFiltered: true,
    });
}

// Render the failure consolidation table — one row per failed/unstable job
function renderFailureView(searchTerm) {
    var rawEntries = collectFailureEntries();
    var term = (searchTerm || '').toLowerCase().trim();
    var entries = term
        ? rawEntries.map(function(e) { return _fvApplyErrorFilter(e, term); }).filter(Boolean)
        : rawEntries;

    var tbody = document.getElementById('fv-tbody');
    if (!tbody) return;

    if (entries.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="fv-empty">'
            + (term ? 'No failures match this search.' : 'No failures found in the current dataset.')
            + '</td></tr>';
        var subEmpty = document.getElementById('fv-subtitle');
        if (subEmpty) subEmpty.textContent = term
            ? 'Showing 0 of ' + rawEntries.length + ' jobs (filtered)'
            : '0 failed jobs';
        return;
    }

    var totalErrors = entries.reduce(function(sum, e) { return sum + e.errorCount; }, 0);
    // Detect whether collectFailureEntries was scoped to a filter/selection.
    // For the unscoped/unsearched line we'd already say "N failed jobs" \u2014 saying
    // "scoped to N filtered jobs" too is tautological. Use a clearer phrasing.
    var mainScope = (typeof getActionScope === 'function') ? getActionScope() : null;
    var scoped = (mainScope && mainScope.label !== 'all');
    var sub = document.getElementById('fv-subtitle');
    if (sub) {
        if (term) {
            sub.textContent = 'Showing ' + entries.length + ' of ' + rawEntries.length + ' jobs (filtered) \u00B7 '
                + totalErrors + ' matching ' + (totalErrors === 1 ? 'error' : 'errors')
                + (scoped ? ' \u00B7 from ' + mainScope.label + ' scope' : '');
        } else if (scoped) {
            sub.textContent = entries.length + ' failed ' + (entries.length === 1 ? 'job' : 'jobs')
                + ' in current ' + mainScope.label + ' scope (of ' + mainScope.totalCount + ' total) \u00B7 '
                + totalErrors + ' ' + (totalErrors === 1 ? 'error' : 'errors');
        } else {
            sub.textContent = entries.length + ' failed ' + (entries.length === 1 ? 'job' : 'jobs')
                + ' \u00B7 ' + totalErrors + ' ' + (totalErrors === 1 ? 'error' : 'errors');
        }
    }

    // Cache entries so the expand handler can look them up by jobId.
    window._fvEntries = {};

    var html = '';
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        window._fvEntries[e.jobId] = e;

        // Collapsed view: first 2 lines + "+N more" hint.
        var summaryLines = e.errorSummary.split('\n');
        var shortDisplay = summaryLines.slice(0, 2).map(function(l) { return escapeHtml(l); }).join('<br>');
        if (summaryLines.length > 2) {
            shortDisplay += '<span class="fv-error-more"> +' + (summaryLines.length - 2) + ' more</span>';
        }

        var countBadge = e.errorCount > 1
            ? '<span class="fv-error-count" title="' + e.errorCount + ' errors">' + e.errorCount + '</span>'
            : '';

        var chevron = '<span class="fv-expand-icon" id="fv-chev-' + i + '">\u25B6</span>';

        html += '<tr data-fv-job="' + escapeHtml(e.jobId) + '" data-fv-search="' + escapeHtml(e.searchBlob) + '" data-fv-idx="' + i + '">'
            + '<td class="fv-col-job"><a class="fv-job-link" href="' + escapeHtml(e.jobUrl) + '" target="_blank" rel="noopener" title="Open in Jenkins">' + escapeHtml(e.jobName) + '</a>' + countBadge + '</td>'
            + '<td class="fv-col-message"><div class="fv-error-summary" onclick="toggleFvDetail(' + i + ')">' + chevron + '<span class="fv-error-msg">' + shortDisplay + '</span></div></td>'
            + '<td class="fv-col-time"><span class="fv-time">' + formatExecTime(e.execTime) + '</span></td>'
            + '<td class="fv-col-actions"><button class="fv-log-btn" onclick="clvOpen(\'' + escapeHtml(e.jobId) + '\')" title="Open console log"><svg width="14" height="14"><use href="#icon-file-text"/></svg></button></td>'
            + '</tr>';
    }
    tbody.innerHTML = html;
}

// Expand/collapse the per-job error detail row in the failure view.
function toggleFvDetail(idx) {
    var tbody = document.getElementById('fv-tbody');
    var existingDetail = document.getElementById('fv-detail-' + idx);

    if (existingDetail) {
        existingDetail.remove();
        var chev = document.getElementById('fv-chev-' + idx);
        if (chev) chev.textContent = '\u25B6';
        return;
    }

    var parentRow = tbody.querySelector('tr[data-fv-idx="' + idx + '"]');
    if (!parentRow) return;
    var jobId = parentRow.getAttribute('data-fv-job');
    var entry = window._fvEntries ? window._fvEntries[jobId] : null;
    if (!entry) return;

    var chev = document.getElementById('fv-chev-' + idx);
    if (chev) chev.textContent = '\u25BC';

    var detailHtml = '<tr id="fv-detail-' + idx + '" class="fv-detail-row">'
        + '<td colspan="4" class="fv-detail-cell">'
        + '<div class="fv-detail-panel">';

    for (var i = 0; i < entry.errorItems.length; i++) {
        var item = entry.errorItems[i];
        var levelClass = item.level === 'FATAL' || item.level === 'SEVERE'
            ? 'fv-detail-level-critical' : 'fv-detail-level-error';
        detailHtml += '<div class="fv-detail-item">'
            + '<div class="fv-detail-header">'
            + '<span class="fv-detail-level ' + levelClass + '">' + escapeHtml(item.level) + '</span>'
            + (item.lineNumber ? '<span class="fv-detail-line">Line ' + item.lineNumber + '</span>' : '')
            + '<span class="fv-detail-idx">' + (i + 1) + ' / ' + entry.errorItems.length + '</span>'
            + '</div>'
            + '<pre class="fv-detail-text">' + escapeHtml(item.detail) + '</pre>'
            + '</div>';
    }

    detailHtml += '</div></td></tr>';

    parentRow.insertAdjacentHTML('afterend', detailHtml);
}

// Switch between the job table and the failure consolidation view.
function toggleFailureView() {
    const jobTable = document.getElementById('job-table');
    const failureView = document.getElementById('failure-view');
    const btnLabel = document.getElementById('ops-failure-view-label');
    if (!jobTable || !failureView) return;

    _failureViewActive = !_failureViewActive;

    if (_failureViewActive) {
        jobTable.style.display = 'none';
        failureView.classList.remove('hidden');
        if (btnLabel) btnLabel.textContent = 'Back to Jobs';
        renderFailureView();
        setToolbarViewState('failures');
        const searchInput = document.getElementById('fv-search');
        if (searchInput) searchInput.value = '';
    } else {
        failureView.classList.add('hidden');
        jobTable.style.display = '';
        if (btnLabel) btnLabel.textContent = 'Failures';
        setToolbarViewState('jobs');
    }
}

// Re-render the failure view filtered by searchTerm.
function filterFailureRows(searchTerm) {
    renderFailureView(searchTerm || '');
}

// Debounce the search input so we don't filter on every keystroke.
document.addEventListener('DOMContentLoaded', function() {
    const fvSearch = document.getElementById('fv-search');
    if (fvSearch) {
        fvSearch.addEventListener('input', function() {
            if (_fvSearchDebounce) clearTimeout(_fvSearchDebounce);
            _fvSearchDebounce = setTimeout(() => filterFailureRows(this.value), 200);
        });
    }
});

// Auto-remove rerun status badges after `delay` ms (10s by default) so the row
// returns to its normal status display.
function scheduleRerunBadgeCleanup(jobIds, delay) {
    jobIds.forEach(jobId => {
        setTimeout(() => {
            appState.rerunStates.delete(jobId);
            const r = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
            if (r) {
                const badge = r.querySelector('.badge-rerun');
                if (badge) badge.remove();
            }
        }, delay);
    });
}

// Trigger Jenkins reruns and reflect the result on each row via the rerun badge.
async function triggerRerun(jobIds) {
    // activeOperationId only flips after the SSE handshake — there's a 0-500ms
    // window after Fetch click where it's null but a fetch is in flight.
    // Also gate on _fetchAbortController so the rerun network call doesn't
    // race with a resetDashboardState() from a still-starting fetch.
    if (appState.activeOperationId || appState._fetchAbortController) {
        showToast('Cannot rerun while a fetch/refresh is in progress', 'warning');
        return;
    }
    const creds = ensureCredentials('Please enter credentials');
    if (!creds) return;

    // Skip jobs already running — Jenkins refuses to queue a rerun for them.
    jobIds = jobIds.filter(jobId => {
        const job = appState.jobs.get(jobId);
        return job && !job.is_running && job.latest_status !== 'IN_PROGRESS';
    });
    if (jobIds.length === 0) {
        showToast('All selected jobs are currently running', 'info');
        return;
    }

    const jobUrls = jobIds.map(jobId => {
        const job = appState.jobs.get(jobId);
        return job ? job.url : jobId;
    });

    jobIds.forEach(jobId => {
        appState.rerunStates.set(jobId, 'Triggering');
        const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
        if (row) {
            updateRerunBadge(row, 'Triggering');
        }
    });

    try {
        const response = await apiFetch('/api/rerun', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_urls: jobUrls,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token
            })
        });

        const result = await response.json();
        if (response.ok) {
            // Backend returns {results: [{job_url, triggered, error}]} —
            // honour per-job outcomes instead of marking every row Triggered.
            const results = Array.isArray(result.results) ? result.results : [];
            const triggeredIds = [];
            const failedIds = [];
            // Map response by URL so we can pair with the row's jobId.
            const byUrl = new Map();
            results.forEach(r => { if (r && r.job_url) byUrl.set(r.job_url, r); });

            jobIds.forEach((jobId, i) => {
                const url = jobUrls[i];
                const r = byUrl.get(url) || byUrl.get(jobId);
                let state = 'TriggerFailed';
                let errMsg = '';
                if (!r) {
                    // URL silently dropped by backend (e.g. didn't belong to instance).
                    state = 'TriggerFailed';
                    errMsg = 'Server did not report a result for this job';
                } else if (r.triggered) {
                    state = 'Triggered';
                    triggeredIds.push(jobId);
                } else {
                    failedIds.push(jobId);
                    errMsg = String(r.error || '').toLowerCase();
                    if (errMsg.includes('permission')) state = 'PermissionDenied';
                    else if (errMsg.includes('disabled')) state = 'JobDisabled';
                    else state = 'TriggerFailed';
                }
                appState.rerunStates.set(jobId, state);
                const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
                if (row) {
                    updateRerunBadge(row, state);
                    // Surface the per-job error message via the badge tooltip.
                    if (state !== 'Triggered' && r && r.error) {
                        const badge = row.querySelector('.badge-rerun');
                        if (badge) badge.title = String(r.error);
                    }
                }
            });

            scheduleRerunBadgeCleanup(jobIds, 10000);

            const total = jobIds.length;
            const ok = triggeredIds.length;
            const bad = failedIds.length + (total - ok - failedIds.length);  // includes silent drops
            if (ok === total) {
                showToast(`${ok} job(s) rerun triggered`, 'success');
            } else if (ok > 0) {
                showToast(`${ok} of ${total} rerun triggered — ${bad} failed (hover the badges for reasons)`, 'warning');
            } else {
                showToast(`All ${total} rerun(s) failed — hover the badges for reasons`, 'error');
            }
        } else {
            throw new Error(result.message || 'Rerun failed');
        }
    } catch (error) {
        jobIds.forEach(jobId => {
            appState.rerunStates.set(jobId, 'TriggerFailed');
            const row = document.querySelector(`tr[data-job-id="${escapeHtml(jobId)}"]`);
            if (row) updateRerunBadge(row, 'TriggerFailed');
        });
        scheduleRerunBadgeCleanup(jobIds, 10000);
        reportFetchError('Rerun', 'Rerun failed for ' + jobIds.length + ' job(s)', '/api/rerun', error, 'Rerun failed: ' + error.message, jobIds.join(', '));
    }
}

// Paint the rerun status badge on a row (Triggering / Triggered / TriggerFailed / etc.).
function updateRerunBadge(row, state) {
    const statusCell = row.querySelector('.cell-status');
    if (!statusCell) return;

    let badge = row.querySelector('.badge-rerun');
    if (!badge) {
        badge = document.createElement('span');
        badge.className = 'badge-rerun';
        statusCell.appendChild(badge);
    }

    badge.className = 'badge-rerun';
    badge.textContent = state;

    if (state === 'Triggered') {
        badge.classList.add('badge-rerun-triggered');
        badge.title = 'Jenkins accepted the build request — this does not mean the build is running yet. Click Refresh to check for a new build.';
    } else if (state === 'TriggerFailed') {
        badge.classList.add('badge-rerun-failed');
        badge.textContent = 'Trigger Failed';
    } else if (state === 'PermissionDenied') {
        badge.classList.add('badge-rerun-denied');
        badge.textContent = 'Permission Denied';
    } else if (state === 'JobDisabled') {
        badge.classList.add('badge-rerun-disabled');
        badge.textContent = 'Job Disabled';
    }
}

// == EXPORT CSV ==

// Export the current view (jobs table OR failure consolidation) to CSV.
function exportCSV() {
    if (_failureViewActive) {
        exportFailureCSV();
        return;
    }
    try {
    // Honour the action-scope rule
    const scope = (typeof getActionScope === 'function') ? getActionScope() : null;
    const visibleJobs = scope
        ? scope.jobIds.map(id => appState.jobs.get(id)).filter(Boolean)
        : getVisibleJobs();
    if (visibleJobs.length === 0) {
        showToast('No jobs in current scope to export', 'info');
        return;
    }
    if (scope && scope.label !== 'all') {
        showToast(`Exporting ${describeScope(scope)}…`, 'info');
    }

    const pt = getPromotionTime();
    const includeRegression = !!pt;

    const headers = [
        'Job Name',
        'Latest Status',
        'Previous Status',
        'Last Passed',
        'Last Execution Time',
        'Tests Executed',
        'Tests Passed',
        'Tests Failed',
        'Test Errors',
        'Tests Skipped',
        'Duration (s)',
        'Metrics Source',
        'Domain',
        'Subcategory',
        'Impact Level',
        'Confidence',
        'Secondary Hint',
        'Log Analysis Labels',
        'Recommended Action',
        'Matched Rule',
        ...(includeRegression ? ['Baseline Validation'] : [])
    ];

    const regressionLabel = { passed: 'Validated', failed: 'Never Passed', in_progress: 'In Progress', not_executed: 'Not Executed Since Promotion' };

    const rows = visibleJobs.map(job => {
        // Use the same extractor the table cells use so CSV numbers match the UI.
        const snap = extractJobMetrics(job);
        const base = [
            escapeCSV(job.name),
            job.latest_status,
            job.previous_status || '',
            job.last_passed ? `${job.last_passed.build}` : '',
            job.last_execution_time || '',
            snap.hasMetrics ? snap.total   : '',
            snap.hasMetrics ? snap.passed  : '',
            snap.hasMetrics ? snap.failed  : '',
            snap.hasMetrics ? snap.errors  : '',
            snap.hasMetrics ? snap.skipped : '',
            job.test_metrics?.duration_seconds || '',
            job.test_metrics?.metrics_source || '',
            job.classification?.primary_domain || '',
            job.classification?.subcategory || '',
            job.classification?.impact || '',
            job.classification?.confidence || '',
            job.classification?.secondary_hint ? escapeCSV(JSON.stringify(job.classification.secondary_hint)) : '',
            job.classification?.all_labels ? job.classification.all_labels.map(l => l.label).join(' | ') : (job.classification?.label || ''),
            job.classification?.action ? escapeCSV(job.classification.action) : '',
            job.classification?.matched_rule_name || ''
        ];
        if (includeRegression) {
            base.push(regressionLabel[deriveRegressionStatus(job, pt)] || '');
        }
        return base;
    });

    const csv = [headers, ...rows].map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const filename = `jenkins-analysis-${timestamp}.csv`;

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    showToast(`Exported ${visibleJobs.length} jobs to ${filename}`, 'success');
    } catch (csvErr) {
        diagLog('error', 'Export', 'CSV export failed', { stack: csvErr.stack, raw: csvErr.message });
        showToast('CSV export failed: ' + csvErr.message, 'error');
    }
}

// Escape embedded double quotes for CSV.
function escapeCSV(str) {
    if (typeof str !== 'string') str = String(str);
    return str.replace(/"/g, '""');
}

// Export failure consolidation view to CSV with full error details per row.
function exportFailureCSV() {
    try {
    var entries = collectFailureEntries();
    if (entries.length === 0) {
        showToast('No failure entries to export', 'info');
        return;
    }
    var headers = ['Job Name', 'Job URL', 'Error Count', 'Error Summary', 'Full Errors', 'Last Execution Time'];
    var rows = entries.map(function(e) {
        var fullText = (e.errorItems || []).map(function(item, idx) {
            return '[' + (idx + 1) + '] ' + (item.level || 'ERROR') + ': ' + (item.detail || item.message || '');
        }).join('\n');
        if (!fullText) fullText = e.errorSummary || '';
        return [
            escapeCSV(e.jobName),
            escapeCSV(e.jobUrl || ''),
            String(e.errorCount),
            escapeCSV(e.errorSummary),
            escapeCSV(fullText),
            e.execTime || ''
        ];
    });
    var csv = [headers].concat(rows).map(function(r) { return r.map(function(c) { return '"' + c + '"'; }).join(','); }).join('\n');
    var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    var filename = 'failure-report-' + timestamp + '.csv';
    var blob = new Blob([csv], { type: 'text/csv' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast('Exported ' + entries.length + ' failed jobs to ' + filename, 'success');
    } catch (csvErr) {
        diagLog('error', 'Export', 'Failure CSV export failed', { stack: csvErr.stack, raw: csvErr.message });
        showToast('Failure CSV export failed: ' + csvErr.message, 'error');
    }
}
