const { useState, useEffect } = React;

        async function authFetch(url, options) {
            try {
                const res = await fetch(url, options);
                if (res.redirected && new URL(res.url).pathname === '/login') {
                    window.location.href = '/login';
                    throw new Error('Redirecting to login');
                }
                if (res.status === 401 || res.status === 403) {
                    window.location.href = '/login';
                    throw new Error('Unauthorized');
                }
                return res;
            } catch (err) {
                window.location.href = '/login';
                throw err;
            }
        }

        function toLocalDateString(isoString) {
            const date = new Date(isoString);
            date.setMinutes(date.getMinutes() + date.getTimezoneOffset());
            return date.toLocaleDateString();
        }

        function App() {
            const [stories, setStories] = useState([]);
            const [page, setPage] = useState(1);
            const [total, setTotal] = useState(0);
            const [q, setQ] = useState('');
            const [date, setDate] = useState('');

            const load = (p = page, search = q, d = date) => {
                const params = new URLSearchParams({ page: String(p) });
                if (search) params.set('q', search);
                if (d) params.set('date', d);
                authFetch(`/stories/list?${params.toString()}`)
                    .then(res => res.json())
                    .then(data => {
                        setStories(data.stories);
                        setTotal(data.total);
                        setPage(p);
                    });
            };

            useEffect(() => load(1, q, date), []);

            const remove = async id => {
                if (!confirm('Are You Sure?')) return;
                const res = await authFetch('/stories/' + id, { method: 'DELETE' });
                if (res.ok) {
                    load(page, q, date);
                } else {
                    alert('Failed to delete');
                }
            };

            const onSearch = e => {
                const value = e.target.value;
                setQ(value);
                load(1, value, date);
            };

            const onDateChange = e => {
                const value = e.target.value;
                setDate(value);
                load(1, q, value);
            };

            const totalPages = Math.ceil(total / 10) || 1;

            return React.createElement(React.Fragment, null, [
                React.createElement('h1', { key: 'h' }, 'Manage Stories'),
                React.createElement('div', { key: 'actions', className: 'actions' }, [
                    React.createElement('button', { key: 'submit', onClick: () => window.location.href = '/submit' }, 'Submit New Story'),
                    React.createElement('button', { key: 'generate', onClick: () => window.location.href = '/generate-story' }, 'Generate with Codex')
                ]),
                React.createElement('div', { key: 'search', className: 'search-wrapper' }, [
                    React.createElement('input', { key: 's', type: 'text', placeholder: 'Search', value: q, onChange: onSearch }),
                    React.createElement('input', { key: 'd', type: 'date', value: date, onChange: onDateChange })
                ]),
                React.createElement('div', { key: 'list', className: 'story-list' }, stories.map(s =>
                    React.createElement('div', { key: s.id, className: 'story-item' }, [
                        React.createElement('span', { key: 't' + s.id }, [
                            s.title,
                            React.createElement('span', { key: 'd' + s.id, className: 'date' }, ' (' + toLocalDateString(s.date) + ')')
                        ]),
                        React.createElement('span', { key: 'a' + s.id, className: 'story-actions' }, [
                            React.createElement('button', { key: 'v', onClick: () => window.location.href = '/?id=' + s.id }, 'View'),
                            React.createElement('button', { key: 'e', onClick: () => window.location.href = '/edit.html?id=' + s.id }, 'Edit'),
                            React.createElement('button', { key: 'd', onClick: () => remove(s.id) }, 'Delete')
                        ])
                    ])
                )),
                React.createElement('div', { key: 'p', className: 'pagination' }, [
                    React.createElement('button', { key: 'prev', disabled: page <= 1, onClick: () => load(page - 1, q, date) }, 'Previous'),
                    React.createElement('span', { key: 'info' }, `Page ${page} of ${totalPages}`),
                    React.createElement('button', { key: 'next', disabled: page >= totalPages, onClick: () => load(page + 1, q, date) }, 'Next')
                ])
            ]);
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(App));
