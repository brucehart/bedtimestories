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

        function App() {
            const [story, setStory] = useState(null);
            const [loading, setLoading] = useState(true);
            const [error, setError] = useState(null);
            const [nextStory, setNextStory] = useState(null);
            const [prevStory, setPrevStory] = useState(null);
            const [imageLoaded, setImageLoaded] = useState(false);
            const [playing, setPlaying] = useState(false);
            const videoRef = React.useRef(null);
            const updateNeighbors = id => {
                Promise.all([
                    authFetch("/stories/" + id + "/prev").then(res => res.ok ? res.json() : null).catch(() => null),
                    authFetch("/stories/" + id + "/next").then(res => res.ok ? res.json() : null).catch(() => null)
                ]).then(([prev, next]) => { setPrevStory(prev); setNextStory(next); });
            };

            const load = id => {
                const url = id ? '/stories/' + id : '/stories';
                return authFetch(url)
                    .then(res => {
                        if (!res.ok) throw new Error('Failed to load');
                        return res.json();
                    });
            };

            const setAndPush = data => {
                setStory(data);
                setImageLoaded(false);
                setPlaying(false);
                history.replaceState(null, '', '?id=' + data.id);
                updateNeighbors(data.id);
            };

            const loadNext = () => {
                if (!nextStory) return;
                setAndPush(nextStory);
            };

            const loadPrev = () => {
                if (!prevStory) return;
                setAndPush(prevStory);
            };

            const toggleVideo = () => {
                if (!story.video_url) return;
                if (playing) {
                    videoRef.current.pause();
                    videoRef.current.currentTime = 0;
                    setPlaying(false);
                } else {
                    videoRef.current.play();
                    setPlaying(true);
                }
            };

            useEffect(() => {
                const params = new URLSearchParams(window.location.search);
                const id = params.get('id');
                load(id)
                    .then(data => { setAndPush(data); setLoading(false); })
                    .catch(err => {
                        console.error(err);
                        setError(err);
                        setLoading(false);
                    });
            }, []);


            if (loading) return React.createElement('p', null, 'Loading...');
            if (error || !story) return React.createElement('p', null, 'Story not found.');

            return React.createElement('div', { className: 'story-container' }, [
                React.createElement('div', { className: 'title-wrapper', key: 'title-wrap' }, [                    React.createElement('h1', { className: 'title', key: 'title' }, story.title),                    React.createElement('div', { className: 'nav-buttons', key: 'nav' }, [                        React.createElement('button', { key: 'up', onClick: loadPrev, disabled: !prevStory }, '▲'),                        React.createElement('button', { key: 'down', onClick: loadNext, disabled: !nextStory }, '▼')                    ])                ]),
                story.image_url ? React.createElement('div', { key: 'media', style: { position: 'relative' } }, [
                    React.createElement('img', { className: 'story-image', src: "/images/" + story.image_url, alt: story.title, onLoad: () => setImageLoaded(true), style: { display: playing ? 'none' : (imageLoaded ? 'block' : 'none') } }),
                    story.video_url ? React.createElement('video', { ref: videoRef, src: "/images/" + story.video_url, loop: true, preload: 'auto', style: { display: playing ? 'block' : 'none', width: '100%', borderRadius: '8px' } }) : null,
                    story.video_url ? React.createElement('button', { className: 'play-btn', onClick: toggleVideo }, playing ? '⏸' : '▶') : null
                ]) : null,
                //React.createElement('p', { className: 'date', key: 'date' }, new Date(story.date).toLocaleDateString()),
                React.createElement('div', {
                    className: 'content',
                    key: 'content',
                    dangerouslySetInnerHTML: { __html: story.content }
                })
            ]);
        }

        const root = ReactDOM.createRoot(document.getElementById('root'));
        root.render(React.createElement(App));
