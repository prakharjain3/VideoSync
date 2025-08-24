const BACKEND_URL = 'http://localhost:8080';
let STREAMING_URL = ""
let isHost = false;
let ws = null;
let latency = 0;

const videoElement = document.getElementById('videoPlayer');
const urlParams = new URLSearchParams(window.location.search);
const sessionKey = urlParams.get('sessionKey');

let chunkDuration = 0;
let chunkCount = 0;
let videoDuration = 0;
let mediaSourceInitialized = false;

// Create new session
async function createNewSession() {
    try {
        console.log('Creating new session...');
        const response = await fetch(`${BACKEND_URL}/api/sessions`, {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('Session created:', data);
        sessionStorage.setItem('hostToken', data.hostToken);

        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set('sessionKey', data.sessionKey);
        newUrl.searchParams.set('hostToken', data.hostToken);
        window.history.replaceState({}, '', newUrl);

        await initializeSession();
    } catch (error) {
        console.error('Failed to create session:', error);
        setStatus('Failed to create session: ' + error.message, true);
    }
}

// Join session
async function initializeSession() {
    try {
        console.log('Initializing session with key:', sessionKey);

        const urlHostToken = urlParams.get('hostToken');
        const storedHostToken = sessionStorage.getItem('hostToken');
        const hostToken = urlHostToken || storedHostToken;

        const validateUrl = `${BACKEND_URL}/api/sessions/${encodeURIComponent(sessionKey)}/validate`;
        const urlWithParams = hostToken ? `${validateUrl}?hostToken=${encodeURIComponent(hostToken)}` : validateUrl;

        console.log('Sending validation request to:', urlWithParams);
        const response = await fetch(urlWithParams);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();
        console.log('Session validation response:', data);

        if (!data.valid) {
            setStatus('Invalid session key', true);
            return;
        }

        isHost = data.isHost;
        console.log('User role:', isHost ? 'Host' : 'Participant');

        if (isHost && hostToken && !urlHostToken) {
            const newUrl = new URL(window.location.href);
            newUrl.searchParams.set('hostToken', hostToken);
            window.history.replaceState({}, '', newUrl);
        }

        // After receiving streaming URL
        STREAMING_URL = data.streaming_url;
        console.log(STREAMING_URL)
        connectWebSocket(STREAMING_URL);

        const player = videojs('videoPlayer', {
            controls: true,
            autoplay: false,
            muted: false,

            fluid: true,
            aspectRatio: '16:9',
        });
        
        // Video.js's built-in HLS handler will choose native vs MSE automatically:
        player.src({
            src: `${STREAMING_URL}/hls/${sessionKey}/master.m3u8`,
            type: 'application/vnd.apple.mpegurl'
        });
        
        // once the player is ready, start playback
        player.ready(() => {
            player.play().catch(e => {
                console.log('Autoplay blocked – waiting for user gesture');
            });
        });

        document.getElementById('sessionKeyDisplay').textContent = sessionKey;
        document.getElementById('userRole').textContent = isHost ? 'Host' : 'Participant';
        updateControls();
        attachCustomControlListeners();

        videoElement.addEventListener('error', (e) => {
            console.error('Video error:', videoElement.error);
            setStatus(`Video error: ${videoElement.error.message}`, true);
        });

        videoElement.addEventListener('stalled', () => {
            setStatus('Video stream stalled - reconnecting...', true);
            videoElement.load(); // Attempt to reload
        });
        
        videoElement.addEventListener('loadeddata', () => {
            setStatus('Video stream connected', false);
            if (isHost) {
                videoElement.play().catch(e => {
                    console.log('Autoplay blocked - waiting for user interaction');
                });
            }
        });

    } catch (error) {
        console.error('Session initialization error:', error);
        setStatus('Failed to initialize session: ' + error.message, true);
    }
}

// Initialize WebSocket connection
function connectWebSocket(streamingUrl) {
    const wsUrl = new URL(`${streamingUrl.replace('http', 'ws')}/ws`);
    wsUrl.searchParams.set('sessionID', sessionKey);
    if (isHost) {
        wsUrl.searchParams.set('isHost', 'true');
    }

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket connected');
        setStatus('Connected to session', false);
        getVideoMetadata()// Request video metadata once connection is established
    };

    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleStreamingServerMessage(data);
    };

    ws.onclose = () => {
        console.log('WebSocket disconnected');
        setStatus('Connection lost - attempting to reconnect...', true);
        setTimeout(() => connectWebSocket(streamingUrl), 3000);
    };

    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        setStatus('Connection error', true);
    };
}

function handleStreamingServerMessage(data) {
    switch (data.type) {
        case 'init':
            handleInitialization(data);
            break;
        case 'stateUpdate':
            handleStateUpdate(data);
            break;
        case 'videoMetadata':
            handleVideoMetadata(data);
            break;
        case 'heartbeat':
            handleHeartbeat(data);
            break;
    }
}

function handleInitialization(data) {
    isHost = data.isHost;
    document.getElementById('userRole').textContent = isHost ? 'Admin' : 'Participant';
    updateControls();
    attachCustomControlListeners(); // <- Attach buttons only once we know isHost

    videoElement.currentTime = data.state.currentTime;
    videoElement.playbackRate = data.state.playbackRate;
    data.state.paused ? videoElement.pause() : videoElement.play();
}

function handleVideoMetadata(data) {
    console.log('Video metadata:', data.state);
    chunkDuration = data.state.chunkDuration;
    chunkCount = data.state.chunkCount;
    videoDuration = data.state.videoDuration;
    videoFileType = data.state.videoFileType;
}

function handleStateUpdate(data) {
    const serverTime = data.servertime;
    const localTime = Date.now();

    latency = localTime - serverTime;

    const currentTime = videoElement.currentTime;
    const targetTime = data.state.currentTime + (latency / 1000);

    if (Math.abs(currentTime - targetTime) > 0.5) {
        videoElement.currentTime = targetTime;
    }

    if (data.state.paused !== videoElement.paused) {
        data.state.paused ? videoElement.pause() : videoElement.play();
    }

    videoElement.playbackRate = data.state.playbackRate;
}

function handleHeartbeat() {
    ws.send(JSON.stringify({ type: 'heartbeatAck' }));
}

// Send player state to backend
function sendPlayerState(type) {
    if (!isHost || !ws || ws.readyState !== WebSocket.OPEN) return;

    const video_state = {
        type: 'stateUpdate',
        state: {
            paused: videoElement.paused,
            currentTime: videoElement.currentTime,
            playbackRate: videoElement.playbackRate,
            timestamp: Date.now()
        }
    };
    ws.send(JSON.stringify(video_state));
}

function getVideoMetadata() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        // WebSocket not ready, set timeout to retry
        console.log("WebSocket not ready, retrying in 500ms...");
        setTimeout(getVideoMetadata, 500);
        return;
    }
    
    console.log("Requesting video metadata");
    ws.send(JSON.stringify({ type: 'videoMetadata' }));
}

// Update UI controls
function updateControls() {
    const playPauseBtn = document.getElementById('playPauseBtn');
    const seekBar = document.getElementById('seekBar');
    playPauseBtn.disabled = !isHost;
    seekBar.disabled = !isHost;
}

// Custom button listeners
function attachCustomControlListeners() {
    const playPauseBtn = document.getElementById('playPauseBtn');
    const seekBar = document.getElementById('seekBar');

    playPauseBtn.addEventListener('click', () => {
        if (!isHost) return;
        if (videoElement.paused) {
            videoElement.play();
        } else {
            videoElement.pause();
        }
    });

    seekBar.addEventListener('input', (e) => {
        if (!isHost) return;
        videoElement.currentTime = parseFloat(e.target.value);
    });
}

// Status message display
function setStatus(message, isError) {
    const statusElement = document.getElementById('statusMessage');
    statusElement.textContent = message;
    statusElement.style.color = isError ? '#D32F2F' : '#388E3C';
    statusElement.style.display = 'block';
    setTimeout(() => {
        statusElement.style.display = 'none';
    }, 3000);
}

// Handle DOM video events
videoElement.addEventListener('play', () => sendPlayerState('play'));
videoElement.addEventListener('pause', () => sendPlayerState('pause'));
videoElement.addEventListener('seeked', () => sendPlayerState('seek'));

videoElement.addEventListener('timeupdate', () => {
    document.getElementById('currentTime').textContent = formatTime(videoElement.currentTime);
    document.getElementById('seekBar').value = videoElement.currentTime;
});

videoElement.addEventListener('loadedmetadata', () => {
    document.getElementById('seekBar').max = videoElement.duration;
    document.getElementById('duration').textContent = formatTime(videoElement.duration);
});

// Entry
if (sessionKey) {
    console.log('Session key found, starting initialization');
    initializeSession();
} else {
    console.log('No session key found, creating new session');
    createNewSession();
}

///////////////////////////////// Helper functions //////////////////////////////////
function formatTime(seconds) {
    const date = new Date(0);
    date.setSeconds(seconds);
    return date.toISOString().substr(11, 8);
}

function triggerLoadedMetadata() {
    const event = new Event('loadedmetadata');
    videoElement.dispatchEvent(event);
}

///////////////////////////////// HLS Player //////////////////////////////////
function setupHLSPlayer(sessionId) {
    if (Hls.isSupported()) {
        const hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 600,
            maxBufferSize: 60 * 1000 * 1000,
        });
        
        const hlsUrl = `${STREAMING_URL}/hls/${sessionId}/master.m3u8`;
        console.log(`Loading HLS stream from: ${hlsUrl}`);
        
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoElement);
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log("HLS manifest parsed, attempting to play");
            videoElement.play().catch(err => {
                console.log("Autoplay prevented:", err);
                setStatus("Click play to start video", false);
            });
        });
        
        hls.on(Hls.Events.ERROR, (event, data) => {
            console.error("HLS error:", data);
            if (data.fatal) {
                switch(data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.log("Network error, attempting to recover");
                        hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.log("Media error, attempting to recover");
                        hls.recoverMediaError();
                        break;
                    default:
                        console.error("Fatal HLS error, destroying player");
                        hls.destroy();
                        setStatus("Playback error - please refresh", true);
                        break;
                }
            }
        });
    } else if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
        // For Safari, which has native HLS support
        videoElement.src = `${streamingUrl}/hls/${sessionId}/master.m3u8`;
        videoElement.addEventListener('loadedmetadata', () => {
            videoElement.play().catch(err => {
                console.log("Autoplay prevented:", err);
            });
        });
    } else {
        setStatus("Your browser doesn't support HLS playback", true);
    }
}