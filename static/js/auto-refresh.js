// Background polling that keeps row statuses fresh without a full refetch.

'use strict';

let AR_INTERVAL_MS = 30000;
const AR_STORAGE_KEY = 'auto_refresh_enabled';
const AR_FLASH_DURATION_MS = 1600;

// Called once at boot with the effective interval from the backend
function setAutoRefreshInterval(ms) {
    const n = Number(ms);
    if (!Number.isFinite(n) || n < 5000 || n > 600000) return;
    AR_INTERVAL_MS = n;
    if (window._autoRefresh && window._autoRefresh.timer) {
        clearInterval(window._autoRefresh.timer);
        window._autoRefresh.timer = setInterval(_pollOnce, AR_INTERVAL_MS);
    }
}

// Exposed on window for diagnostics only.
window._autoRefresh = {
    enabled: null,         // null = uninitialised, true/false = user choice
    timer: null,
    lastStatuses: new Map(), // jobId → "<build_number>:<status>"
    inFlight: false,
};

//  Preference persistence 

function _isAutoRefreshOn() {
    if (window._autoRefresh.enabled !== null) return window._autoRefresh.enabled;
    try {
        const stored = localStorage.getItem(AR_STORAGE_KEY);
        return stored === null ? true : stored === '1';   // default ON
    } catch (_) {
        return true;
    }
}

function _setAutoRefreshOn(on) {
    window._autoRefresh.enabled = !!on;
    try { localStorage.setItem(AR_STORAGE_KEY, on ? '1' : '0'); } catch (_) {}
}

//  Guards: reasons to skip a poll tick 

function _shouldSkipThisTick() {
    if (document.hidden) return 'tab hidden';
    if (window._autoRefresh.inFlight) return 'previous poll in flight';
    if (appState && appState._fetchAbortController) return 'manual fetch in progress';
    if (!appState || !appState.jobs || appState.jobs.size === 0) return 'no jobs in view';
    if (!appState.authCredentials) return 'no credentials';
    return null;
}

// Stable signature used to detect "anything changed for this job".
function _sig(buildNumber, status, isRunning) {
    return (buildNumber == null ? '' : String(buildNumber))
         + ':' + (status || '')
         + ':' + (isRunning ? 'R' : 'D');
}

//  Core poll 

async function _pollOnce() {
    const skipReason = _shouldSkipThisTick();
    if (skipReason) return;

    window._autoRefresh.inFlight = true;
    try {
        const creds = appState.authCredentials;
        const jobUrls = Array.from(appState.jobs.keys());

        // Prune keys for jobs no longer in appState — otherwise a fetch reset
        // leaves stale signatures forever, growing the map indefinitely.
        const currentUrlSet = new Set(jobUrls);
        for (const key of Array.from(window._autoRefresh.lastStatuses.keys())) {
            if (!currentUrlSet.has(key)) window._autoRefresh.lastStatuses.delete(key);
        }
        const viewUrl = appState.currentViewUrl || '';
        const sourceMode = appState.sourceMode || '';
        const tickStart = performance.now();

        const resp = await apiFetch('/api/poll-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_urls: jobUrls,
                view_url: viewUrl,
                source_mode: sourceMode,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token,
            }),
        });

        if (resp.status === 401 || resp.status === 403) {
            // Credentials no longer valid — stop silently.
            _stopAutoRefresh('auth');
            return;
        }
        if (!resp.ok) {
            diagLog && diagLog('warning', 'AutoRefresh', `Poll failed HTTP ${resp.status}`);
            // Tell the freshness chip the data may be stale.
            if (typeof markDataStale === 'function') markDataStale(`Poll HTTP ${resp.status}`);
            return;
        }

        const data = await resp.json();
        const statuses = Array.isArray(data.statuses) ? data.statuses : [];
        // Stamp freshness even when nothing changed — release managers see a
        // continuously-updating timestamp instead of a frozen one.
        if (typeof markDataFresh === 'function') markDataFresh();

        // Diff against last seen signatures. The first poll just seeds the
        // cache so we don't fire a false-positive "everything changed" toast.
        // Track separately the jobs whose build_number actually incremented —
        // only those should clear a TRIGGERED rerun badge.
        const changed = [];
        const buildIncrementedSet = new Set();
        const isFirstPoll = window._autoRefresh.lastStatuses.size === 0;
        let sawError = false;

        for (const s of statuses) {
            // Per-job ERROR from the poll = transient Jenkins blip. Don't
            // cache the signature so the next tick retries; flag the dataset
            // as stale so the user sees the row may be out of date.
            if (s.status === 'ERROR') {
                sawError = true;
                continue;
            }
            const sig = _sig(s.build_number, s.status, !!s.is_running);
            const previous = window._autoRefresh.lastStatuses.get(s.job_url);
            window._autoRefresh.lastStatuses.set(s.job_url, sig);
            if (!isFirstPoll && previous !== undefined && previous !== sig) {
                changed.push(s.job_url);
                // build_number lives at the head of the signature ("N:STATUS:R").
                const prevBN = previous ? parseInt(previous.split(':')[0], 10) : NaN;
                const currBN = (s.build_number != null) ? Number(s.build_number) : NaN;
                if (Number.isFinite(prevBN) && Number.isFinite(currBN) && currBN > prevBN) {
                    buildIncrementedSet.add(s.job_url);
                }
            }
        }

        if (sawError && typeof markDataStale === 'function') {
            markDataStale('one or more rows returned ERROR from Jenkins poll');
        }

        // One summary line per tick
        const tookMs = Math.round(performance.now() - tickStart);
        const backDiag = (data && data.diag) || {};
        const summary = 'polled=' + jobUrls.length
                      + ' batched=' + (backDiag.batched || 0)
                      + ' per_job=' + (backDiag.per_job || 0)
                      + ' jenkins=' + (backDiag.jenkins_calls != null ? backDiag.jenkins_calls : '?')
                      + ' changed=' + changed.length
                      + ' took=' + tookMs + 'ms';
        diagLog && diagLog('info', 'AutoRefresh', summary);

        if (!changed.length) return;

        // Priority-aware enrichment order
        const orderedChanged = (typeof sortJobUrlsByPriority === 'function')
            ? sortJobUrlsByPriority(changed)
            : changed;

        // For each changed job
        await _runWithConcurrencyLimit(orderedChanged, _enrichChangedJob, 3);

        // Clear the TRIGGERED rerun badge ONLY for jobs whose build_number
        // actually incremented — a status flicker on the same build (e.g. a
        // still-pending rerun) must keep the badge so the user sees their
        // action is in flight.
        orderedChanged.forEach(jobUrl => {
            if (buildIncrementedSet.has(jobUrl)) _clearRerunBadge(jobUrl);
        });

        orderedChanged.forEach(_flashRow);
        _showAutoRefreshToast(orderedChanged.length);

        // After enrichment, re-derive release-status badges and refresh the
        // Validation panel counts so the per-row chip + the panel rerun
        // button stay in sync with the latest job state.
        if (appState.promotionTime) {
            if (typeof recalculateAllRegressionCells === 'function') {
                recalculateAllRegressionCells(appState.promotionTime);
            }
            if (typeof updatePromotionPanel === 'function') {
                updatePromotionPanel(appState.promotionTime);
            }
        }

        // If the failure view is open, re-render it so the consolidated
        // list reflects the latest statuses + error_logs. Preserve the
        // user's in-progress search input value + caret across the rebuild.
        if (typeof _failureViewActive !== 'undefined' && _failureViewActive
            && typeof renderFailureView === 'function') {
            const fvSearchEl = document.getElementById('fv-search');
            const term = fvSearchEl ? fvSearchEl.value : '';
            const caret = fvSearchEl ? fvSearchEl.selectionStart : null;
            renderFailureView(term);
            // renderFailureView doesn't touch the input itself, but if it ever
            // does in future, restore caret defensively.
            if (fvSearchEl && caret != null && document.activeElement === fvSearchEl) {
                try { fvSearchEl.setSelectionRange(caret, caret); } catch (_) {}
            }
        }

    } catch (err) {
        diagLog && diagLog('warning', 'AutoRefresh', 'Poll error: ' + (err && err.message));
        if (typeof markDataStale === 'function') markDataStale(err && err.message);
    } finally {
        window._autoRefresh.inFlight = false;
    }
}

// Sliding-window concurrency limiter — at most `limit` workers in flight.
// Errors are swallowed per item since auto-refresh is best-effort.
async function _runWithConcurrencyLimit(items, worker, limit) {
    let i = 0;
    async function pump() {
        while (i < items.length) {
            const idx = i++;
            try {
                await worker(items[idx]);
            } catch (_) { /* best-effort */ }
        }
    }
    const runners = [];
    const n = Math.min(limit, items.length);
    for (let k = 0; k < n; k++) runners.push(pump());
    await Promise.all(runners);
}

async function _enrichChangedJob(jobUrl) {
    const creds = appState.authCredentials;
    const existing = appState.jobs.get(jobUrl);
    const jobName = existing ? (existing.name || existing.job_name) : jobUrl.split('/').pop();
    try {
        const resp = await apiFetch('/api/refresh-single', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_url: jobUrl,
                job_name: jobName,
                jenkins_url: creds.jenkins_url,
                username: creds.username,
                api_token: creds.api_token,
                promotion_time: (typeof getPromotionTimeISO === 'function') ? getPromotionTimeISO() : '',
            }),
        });
        if (!resp.ok) {
            if (resp.status === 429 && typeof diagLog === 'function') {
                diagLog('warning', 'AutoRefresh',
                    'refresh-single throttled (429) — skipped this tick; next poll will retry',
                    { url: jobUrl });
            }
            return;
        }
        const data = await resp.json();
        // Merge into the existing record — never replace. The backend returns
        // job_name/job_url but the UI reads name/url, and a wholesale replace
        // strips those fields and breaks search.
        if (data && data.job_url) {
            const normKey = (typeof _normJobKey === 'function') ? _normJobKey(data.job_url) : data.job_url;
            const existing = appState.jobs.get(normKey) || {};
            // Derive is_running from current_status if the wire payload omits
            // it — without this fallback, a stale is_running=true survives and
            // keeps the rerun button disabled on a now-failed job.
            const nextRunning = (data.is_running !== undefined)
                ? !!data.is_running
                : (data.current_status === 'IN_PROGRESS');
            const merged = Object.assign({}, existing, data, {
                latest_status: data.current_status,
                is_running:    nextRunning,
                // Preserve canonical name/url that the rest of the frontend reads.
                name: data.job_name || existing.name,
                url:  data.job_url  || existing.url,
                job_id: existing.job_id || data.job_url,
            });
            appState.jobs.set(normKey, merged);
            if (typeof updateJobRow === 'function') {
                updateJobRow(normKey, merged);
            }
        }
    } catch (_) {
        // Stay silent so the polling loop keeps running.
    }
}

//  Visual feedback 

function _flashRow(jobUrl) {
    const row = getJobRowEl(jobUrl);
    if (!row) return;
    row.classList.remove('row-auto-refresh-flash');
    // Force reflow so the animation restarts when it's already running.
    void row.offsetWidth;
    row.classList.add('row-auto-refresh-flash');
    setTimeout(() => row.classList.remove('row-auto-refresh-flash'), AR_FLASH_DURATION_MS + 100);
}

// Drop the TRIGGERED chip immediately when fresh status arrives —
// implicit proof the rerun landed, so no need to wait for the 10s timer.
function _clearRerunBadge(jobUrl) {
    if (appState && appState.rerunStates) {
        appState.rerunStates.delete(jobUrl);
    }
    const row = getJobRowEl(jobUrl);
    if (!row) return;
    const badge = row.querySelector('.badge-rerun');
    if (badge) badge.remove();
}

function _showAutoRefreshToast(n) {
    const msg = n === 1 ? '1 job updated' : (n + ' jobs updated');
    if (typeof showToast === 'function') {
        showToast(msg, 'info');
    }
}

//  Lifecycle 

function _startAutoRefresh() {
    if (window._autoRefresh.timer) return;
    window._autoRefresh.lastStatuses.clear();
    // Seed the cache from the already-fetched jobs so the FIRST poll
    if (window.appState && window.appState.jobs) {
        window.appState.jobs.forEach((job, jobUrl) => {
            const sig = _sig(
                job.last_build_number,
                job.latest_status,
                !!(job.is_running || job.latest_status === 'IN_PROGRESS')
            );
            window._autoRefresh.lastStatuses.set(jobUrl, sig);
        });
    }
    window._autoRefresh.timer = setInterval(_pollOnce, AR_INTERVAL_MS);
    // Fire one quick poll so changes surface immediately, not after a tick.
    setTimeout(_pollOnce, 1500);
}

function _stopAutoRefresh(_reason) {
    if (window._autoRefresh.timer) {
        clearInterval(window._autoRefresh.timer);
        window._autoRefresh.timer = null;
    }
    window._autoRefresh.lastStatuses.clear();
}

// Bound to the toolbar Auto button.
function toggleAutoRefresh() {
    const next = !_isAutoRefreshOn();
    _setAutoRefreshOn(next);
    _updateAutoRefreshButton(next);
    if (next) _startAutoRefresh();
    else _stopAutoRefresh('user');
    if (typeof showToast === 'function') {
        showToast('Auto-refresh: ' + (next ? 'ON' : 'OFF'), 'info');
    }
}

function _updateAutoRefreshButton(on) {
    const btn = document.getElementById('btn-auto-refresh');
    if (!btn) return;
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.classList.toggle('auto-refresh-on', !!on);
    btn.classList.toggle('auto-refresh-off', !on);
    // Label stays "Auto" — colour conveys on/off, aria-pressed handles a11y.
    const label = btn.querySelector('.btn-auto-refresh-label');
    if (label) label.textContent = 'Auto';
}

// Pause polling while the tab is hidden; resume on return.
document.addEventListener('visibilitychange', () => {
    if (!_isAutoRefreshOn()) return;
    if (document.hidden) {
        // Leave the timer running — _shouldSkipThisTick handles the skip.
    } else {
        // Foreground again — poll immediately rather than wait up to 30s.
        setTimeout(_pollOnce, 250);
    }
});

// Called by app.js after the first successful fetch populates appState.jobs.
function initAutoRefresh() {
    const on = _isAutoRefreshOn();
    _setAutoRefreshOn(on);  // normalise + persist default
    _updateAutoRefreshButton(on);
    if (on) _startAutoRefresh();
}
