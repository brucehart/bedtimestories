const { useState, useEffect } = React;

        async function agentFetch(url, options) {
            const res = await fetch(url, options);
            if (res.redirected && new URL(res.url).pathname === '/login') {
                window.location.href = '/login';
                throw new Error('Redirecting to login');
            }
            if (res.status === 401) {
                window.location.href = '/login';
                throw new Error('Unauthorized');
            }
            return res;
        }

        async function responseErrorMessage(res, fallback) {
            let text = '';
            try { text = await res.text(); } catch {}
            if (/<\s*(!doctype|html|head|body)\b/i.test(text)) {
                return fallback || `${res.status} ${res.statusText || 'Error'}`;
            }
            const normalized = text.replace(/\s+/g, ' ').trim();
            return normalized
                ? normalized.slice(0, 600)
                : fallback || `${res.status} ${res.statusText || 'Error'}`;
        }

        function displayMessage(value) {
            const text = String(value || '');
            if (/<\s*(!doctype|html|head|body)\b/i.test(text)) {
                return 'Upstream service returned an HTML error page.';
            }
            return text.length > 800 ? text.slice(0, 797) + '...' : text;
        }

        function shortPrompt(value) {
            if (!value) return '';
            return value.length > 80 ? value.slice(0, 77) + '...' : value;
        }

        function imageFilesFromList(list) {
            return Array.from(list || []).filter(file => file && file.type && file.type.startsWith('image/'));
        }

        function statusDotClass(status) {
            return 'status-dot status-' + String(status || '').toLowerCase();
        }

        function formatJobDate(value) {
            if (!value) return '';
            const date = new Date(value);
            return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
        }

        function jobDisplayTitle(job) {
            if (!job) return 'No job selected';
            return job.title || shortPrompt(job.prompt) || 'Story generation job';
        }

        function App() {
            const [agentPrompt, setAgentPrompt] = useState('');
            const [agentDate, setAgentDate] = useState('');
            const [agentFiles, setAgentFiles] = useState([]);
            const [agentFileInputKey, setAgentFileInputKey] = useState(0);
            const [agentJobs, setAgentJobs] = useState([]);
            const [activeJob, setActiveJob] = useState(null);
            const [agentEvents, setAgentEvents] = useState([]);
            const [agentMessage, setAgentMessage] = useState('');
            const [agentBusy, setAgentBusy] = useState(false);
            const [agentError, setAgentError] = useState('');
            const [agentUnavailable, setAgentUnavailable] = useState('');

            const loadAgentJobs = async () => {
                const res = await agentFetch('/agent/jobs');
                if (res.status === 403 || res.status === 503) {
                    setAgentUnavailable(await responseErrorMessage(res, 'Codex generation is not available for this account.'));
                    return;
                }
                if (!res.ok) {
                    setAgentError(await responseErrorMessage(res, 'Could not load generation jobs.'));
                    return;
                }
                const data = await res.json();
                const jobs = data.jobs || [];
                setAgentUnavailable('');
                setAgentJobs(jobs);
                setActiveJob(current => {
                    if (!current) return jobs[0] || null;
                    return jobs.find(job => job.id === current.id) || current;
                });
            };

            const refreshAgentJob = async id => {
                const res = await agentFetch('/agent/jobs/' + encodeURIComponent(id));
                if (!res.ok) return;
                const data = await res.json();
                setActiveJob(data.job);
                setAgentJobs(jobs => jobs.map(job => job.id === data.job.id ? data.job : job));
            };

            useEffect(() => { loadAgentJobs(); }, []);

            useEffect(() => {
                if (!activeJob) return;
                setAgentEvents([]);
                let lastId = 0;
                let closed = false;
                let source = null;
                const connect = () => {
                    if (closed) return;
                    const suffix = lastId ? '?after=' + lastId : '';
                    source = new EventSource('/agent/jobs/' + encodeURIComponent(activeJob.id) + '/events' + suffix);
                    const onEvent = event => {
                        if (typeof event.data !== 'string') return;
                        lastId = Math.max(lastId, Number(event.lastEventId || 0));
                        let data = {};
                        try { data = JSON.parse(event.data); } catch { data = { message: event.data }; }
                        setAgentEvents(events => events.concat([{ id: lastId, type: event.type, message: data.message || '', metadata: data.metadata || null }]).slice(-200));
                        if (['complete','failed','canceled','running','starting','status'].includes(event.type)) {
                            refreshAgentJob(activeJob.id);
                            loadAgentJobs();
                        }
                    };
                    const onConnectionError = event => {
                        if (typeof event.data === 'string') {
                            onEvent(event);
                            return;
                        }
                        if (source) source.close();
                        if (!closed) setTimeout(connect, 2500);
                    };
                    ['status','log','feedback','warning','complete','failed','canceled','running','starting'].forEach(type => source.addEventListener(type, onEvent));
                    source.addEventListener('error', onConnectionError);
                };
                connect();
                return () => {
                    closed = true;
                    if (source) source.close();
                };
            }, [activeJob && activeJob.id]);

            const addAgentFiles = files => {
                const images = imageFilesFromList(files);
                if (images.length === 0) return;
                setAgentError('');
                setAgentFiles(current => {
                    const next = current.concat(images).slice(0, 3);
                    if (current.length + images.length > 3) {
                        setAgentError('Only the first 3 reference images will be used.');
                    }
                    return next;
                });
            };

            const onAgentFileChange = e => {
                addAgentFiles(e.target.files || []);
                setAgentFileInputKey(value => value + 1);
            };

            const onAgentPromptPaste = e => {
                const pastedFiles = imageFilesFromList(e.clipboardData && e.clipboardData.files);
                if (pastedFiles.length > 0) {
                    addAgentFiles(pastedFiles);
                    if (!e.clipboardData.getData('text')) {
                        e.preventDefault();
                    }
                    return;
                }
                const itemFiles = Array.from((e.clipboardData && e.clipboardData.items) || [])
                    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
                    .map(item => item.getAsFile())
                    .filter(Boolean);
                if (itemFiles.length > 0) {
                    addAgentFiles(itemFiles);
                    if (!e.clipboardData.getData('text')) {
                        e.preventDefault();
                    }
                }
            };

            const removeAgentFile = index => {
                setAgentFiles(files => files.filter((_, i) => i !== index));
            };

            const startAgentJob = async e => {
                e.preventDefault();
                setAgentError('');
                setAgentBusy(true);
                const fd = new FormData();
                fd.append('prompt', agentPrompt.trim());
                if (agentDate) fd.append('date', agentDate);
                agentFiles.forEach(file => fd.append('ref_images', file, file.name));
                try {
                    const res = await agentFetch('/agent/jobs', { method: 'POST', body: fd });
                    if (!res.ok) {
                        setAgentError(await responseErrorMessage(res, 'Could not start the generation job.'));
                        return;
                    }
                    const data = await res.json();
                    setActiveJob(data.job);
                    setAgentJobs(jobs => [data.job].concat(jobs.filter(job => job.id !== data.job.id)));
                    setAgentPrompt('');
                    setAgentDate('');
                    setAgentFiles([]);
                    setAgentFileInputKey(value => value + 1);
                } finally {
                    setAgentBusy(false);
                }
            };

            const selectAgentJob = job => {
                setAgentError('');
                setActiveJob(job);
            };

            const sendAgentMessage = async e => {
                e.preventDefault();
                if (!activeJob || !agentMessage.trim()) return;
                const content = agentMessage.trim();
                setAgentMessage('');
                const res = await agentFetch('/agent/jobs/' + encodeURIComponent(activeJob.id) + '/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                if (!res.ok) setAgentError(await responseErrorMessage(res, 'Could not send feedback.'));
            };

            const cancelAgent = async () => {
                if (!activeJob || !confirm('Cancel this generation job?')) return;
                const res = await agentFetch('/agent/jobs/' + encodeURIComponent(activeJob.id) + '/cancel', { method: 'POST' });
                if (res.ok) refreshAgentJob(activeJob.id);
                else setAgentError(await responseErrorMessage(res, 'Could not cancel the job.'));
            };

            const agentActive = activeJob && !['complete','failed','canceled'].includes(activeJob.status);
            const logText = agentEvents.length
                ? agentEvents.map(event => `[${event.type}] ${displayMessage(event.message)}`).join('\n')
                : 'Waiting for events...';

            return React.createElement('main', { className: 'page' }, [
                React.createElement('div', { key: 'title', className: 'title-row' }, [
                    React.createElement('h1', { key: 'h' }, 'Generate Story with Codex'),
                    React.createElement('a', { key: 'back', href: '/manage', className: 'title-link' }, 'Manage Stories')
                ]),
                agentUnavailable ? React.createElement('div', { key: 'unavailable', className: 'empty-state' }, agentUnavailable) : React.createElement(React.Fragment, { key: 'agent' }, [
                    React.createElement('section', { key: 'prompt', className: 'prompt-panel' }, [
                        React.createElement('form', { key: 'f', className: 'agent-form', onSubmit: startAgentJob }, [
                            React.createElement('textarea', { key: 'p', placeholder: 'Story idea', value: agentPrompt, required: true, maxLength: 4000, onPaste: onAgentPromptPaste, onChange: e => setAgentPrompt(e.target.value) }),
                            React.createElement('div', { key: 'r', className: 'agent-row' }, [
                                React.createElement('input', { key: 'd', type: 'date', value: agentDate, onChange: e => setAgentDate(e.target.value) }),
                                React.createElement('input', { key: 'i' + agentFileInputKey, type: 'file', accept: 'image/jpeg,image/png,image/webp', multiple: true, onChange: onAgentFileChange }),
                                React.createElement('button', { key: 'b', type: 'submit', disabled: agentBusy || !agentPrompt.trim() }, agentBusy ? 'Starting...' : 'Start')
                            ]),
                            agentFiles.length ? React.createElement('div', { key: 'files', className: 'agent-files' }, agentFiles.map((file, index) =>
                                React.createElement('span', { key: file.name + index, className: 'agent-file' }, [
                                    file.name || 'pasted image',
                                    React.createElement('button', { key: 'x', type: 'button', onClick: () => removeAgentFile(index), 'aria-label': 'Remove reference image' }, 'x')
                                ])
                            )) : null
                        ]),
                        agentError ? React.createElement('div', { key: 'err', className: 'agent-error' }, agentError) : null
                    ]),
                    React.createElement('div', { key: 'workspace', className: 'workspace' }, [
                        React.createElement('aside', { key: 'jobs', className: 'jobs-panel' }, [
                            React.createElement('div', { key: 'head', className: 'panel-heading' }, [
                                React.createElement('h2', { key: 'h' }, 'Jobs'),
                                React.createElement('button', { key: 'refresh', type: 'button', onClick: loadAgentJobs }, 'Refresh')
                            ]),
                            agentJobs.length ? React.createElement('div', { key: 'list', className: 'job-list' }, agentJobs.map(job =>
                                React.createElement('button', { key: job.id, type: 'button', className: 'job-button' + (activeJob && activeJob.id === job.id ? ' selected' : ''), onClick: () => selectAgentJob(job) }, [
                                    React.createElement('span', { key: 'title', className: 'job-title' }, [
                                        React.createElement('span', { key: 'dot', className: statusDotClass(job.status), 'aria-hidden': 'true' }),
                                        React.createElement('span', { key: 'prompt', className: 'job-prompt' }, shortPrompt(job.prompt))
                                    ]),
                                    React.createElement('span', { key: 'meta', className: 'job-meta' }, [job.status, formatJobDate(job.created)].filter(Boolean).join(' - '))
                                ])
                            )) : React.createElement('div', { key: 'empty', className: 'empty-state' }, 'No generation jobs yet.')
                        ]),
                        React.createElement('section', { key: 'detail', className: 'job-detail' }, activeJob ? [
                            React.createElement('div', { key: 'head', className: 'detail-header' }, [
                                React.createElement('div', { key: 'copy' }, [
                                    React.createElement('h2', { key: 'h' }, jobDisplayTitle(activeJob)),
                                    React.createElement('span', { key: 'status', className: 'status-badge' }, [
                                        React.createElement('span', { key: 'dot', className: statusDotClass(activeJob.status), 'aria-hidden': 'true' }),
                                        activeJob.status
                                    ])
                                ]),
                                React.createElement('div', { key: 'actions', className: 'detail-actions' }, [
                                    activeJob.review_url ? React.createElement('a', { key: 'review', className: 'review-link', href: activeJob.review_url, target: '_blank', rel: 'noopener' }, 'Review created story') : null,
                                    agentActive ? React.createElement('button', { key: 'cancel', type: 'button', onClick: cancelAgent }, 'Cancel') : null
                                ])
                            ]),
                            activeJob.error ? React.createElement('div', { key: 'joberr', className: 'agent-error' }, displayMessage(activeJob.error)) : null,
                            React.createElement('div', { key: 'log', className: 'agent-log' }, logText),
                            agentActive ? React.createElement('form', { key: 'chat', className: 'agent-chat', onSubmit: sendAgentMessage }, [
                                React.createElement('input', { key: 'm', type: 'text', value: agentMessage, maxLength: 2000, placeholder: 'Send feedback', onChange: e => setAgentMessage(e.target.value) }),
                                React.createElement('button', { key: 'send', type: 'submit', disabled: !agentMessage.trim() }, 'Send')
                            ]) : null
                        ] : React.createElement('div', { className: 'empty-state' }, 'Select a generation job.'))
                    ])
                ])
            ]);
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(App));
