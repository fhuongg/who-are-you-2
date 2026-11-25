// Who are you? — all JavaScript for the prototype.
// Plain JavaScript, no build step. Libraries load from CDNs (see the import map in index.html).
// It is a classic script (not type="module"), so index.html also opens straight from the
// file system by double-clicking it.
// index.html runs the installation; index.html?station runs the laptop voice station.

(async () => {
    const THREE = await import('three');
    const { ARButton } = await import('three/addons/webxr/ARButton.js');
    const { default: Sentiment } = await import('sentiment');
    const mqttModule = await import('mqtt');
    const mqtt = mqttModule.default ?? mqttModule;

    // ---------------------------------------------------------------------------
    // Impressions: categories, colours and patches
    // ---------------------------------------------------------------------------
    const CATEGORY_COLORS = {
        Negative: '#263A72',
        Neutral: '#87CEEB',
        Positive: '#E88AB8',
    };
    class PatchGenerator {
        static patchGeometry = new THREE.BoxGeometry(0.075, 0.038, 0.008);
        static createPatch(category) {
            const color = CATEGORY_COLORS[category];
            const material = new THREE.MeshPhongMaterial({
                color: new THREE.Color(color),
                shininess: 10,
            });
            const patch = new THREE.Mesh(this.patchGeometry, material);
            patch.name = `patch-${category}-${Date.now()}`;
            return patch;
        }
    }

    // ---------------------------------------------------------------------------
    // Persona model
    // ---------------------------------------------------------------------------
    class PersonaModel {
        mesh;
        constructor() {
            this.mesh = new THREE.Group();
            this.createPlaceholder();
        }
        createPlaceholder() {
            // Stylised human mannequin built from simple shapes: about 1.77 m tall, standing on
            // the floor, arms relaxed. Matte grey "clay" so the coloured impressions stand out.
            const skin = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.62, metalness: 0 });
            const add = (geometry, name, position, rotation, scale) => {
                const part = new THREE.Mesh(geometry, skin);
                part.name = name;
                part.userData.skin = true; // impressions can land on this part
                part.position.set(...position);
                if (rotation) part.rotation.set(...rotation);
                if (scale) part.scale.set(...scale);
                this.mesh.add(part);
                return part;
            };
            const limb = (radius, length) => new THREE.CapsuleGeometry(radius, length, 8, 24);
            // Head (slightly egg-shaped) with a soft nose and ears
            add(new THREE.SphereGeometry(0.115, 64, 48), 'head', [0, 1.635, 0], null, [0.92, 1.15, 1]);
            add(new THREE.SphereGeometry(0.022, 24, 16), 'nose', [0, 1.62, 0.108], null, [0.8, 1.2, 1]);
            add(new THREE.SphereGeometry(0.03, 24, 16), 'ear', [-0.105, 1.635, 0], null, [0.45, 1, 0.8]);
            add(new THREE.SphereGeometry(0.03, 24, 16), 'ear', [0.105, 1.635, 0], null, [0.45, 1, 0.8]);
            // Neck
            add(new THREE.CylinderGeometry(0.048, 0.056, 0.14, 32), 'neck', [0, 1.47, 0]);
            // Torso: lathe profile from hips to shoulders, flattened front to back
            const profile = [
                [0.0, 0.86], [0.15, 0.87], [0.175, 0.92], [0.17, 1.0], [0.145, 1.08],
                [0.15, 1.16], [0.175, 1.26], [0.19, 1.34], [0.175, 1.4], [0.11, 1.44], [0.0, 1.45],
            ].map(([x, y]) => new THREE.Vector2(x, y));
            add(new THREE.LatheGeometry(profile, 64), 'torso', [0, 0, 0], null, [1, 1, 0.62]);
            // Shoulders, arms and hands (relaxed, slightly away from the body)
            for (const side of [-1, 1]) {
                add(new THREE.SphereGeometry(0.058, 32, 24), 'shoulder', [side * 0.19, 1.385, 0]);
                add(limb(0.047, 0.24), 'upper-arm', [side * 0.225, 1.235, 0], [0, 0, side * 0.16]);
                add(limb(0.04, 0.22), 'forearm', [side * 0.262, 0.98, 0.02], [-0.1, 0, side * 0.1]);
                add(new THREE.SphereGeometry(0.045, 24, 16), 'hand', [side * 0.278, 0.82, 0.035], null, [0.75, 1.35, 0.5]);
                // Legs and feet
                add(limb(0.075, 0.33), 'thigh', [side * 0.09, 0.67, 0], [0, 0, side * -0.02]);
                add(limb(0.058, 0.32), 'calf', [side * 0.095, 0.28, 0]);
                add(new THREE.SphereGeometry(0.06, 24, 16), 'foot', [side * 0.1, 0.035, 0.05], null, [0.75, 0.55, 1.65]);
            }
            // Soft contact shadow under the feet so the persona feels grounded (also in AR).
            this.mesh.add(createContactShadow());
        }
        /** Body parts that impressions can be placed on. */
        get skinParts() {
            return this.mesh.children.filter((child) => child.userData.skin);
        }
        getRegionPosition(region) {
            const part = this.mesh.getObjectByName(region);
            if (part) {
                return part.position.clone();
            }
            return new THREE.Vector3(0, 1.6, 0); // Default to head level
        }
    }
    function createContactShadow() {
        const size = 128;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        gradient.addColorStop(0, 'rgba(0, 0, 0, 0.45)');
        gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);
        const shadow = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false }));
        shadow.rotation.x = -Math.PI / 2;
        shadow.position.y = 0.002;
        shadow.name = 'contact-shadow';
        return shadow;
    }

    // ---------------------------------------------------------------------------
    // Voice: speech recognition + sentiment
    // ---------------------------------------------------------------------------
    const RECOGNITION_LANG = 'en-US';
    const ERROR_MESSAGES = {
        'not-allowed': 'Microphone permission was denied. Allow microphone access and try again.',
        'service-not-allowed': 'Microphone access is blocked by the browser. Update the site settings and try again.',
        'audio-capture': 'No microphone was found. Check your device and try again.',
        'no-speech': 'No speech detected. Press and speak again.',
        network: 'Speech recognition needs a network connection. Check it and try again.',
        'language-not-supported': 'English (en-US) speech recognition is not supported in this browser.',
        aborted: 'Recording stopped. Press and speak again.',
    };
    function getSpeechRecognitionConstructor() {
        if (typeof window === 'undefined')
            return null;
        const { SpeechRecognition, webkitSpeechRecognition } = window;
        return SpeechRecognition ?? webkitSpeechRecognition ?? null;
    }
    function isSpeechRecognitionSupported() {
        return getSpeechRecognitionConstructor() !== null;
    }
    const sentiment = new Sentiment();
    // Extra words for judging how someone looks, added to the general AFINN word list.
    // Scores run from -5 (very negative) to +5 (very positive).
    const APPEARANCE_WORDS = {
        // negative
        fat: -3, fatty: -3, obese: -3, overweight: -2, chubby: -1, plump: -1, bloated: -2, flabby: -2,
        skinny: -2, thin: -1, scrawny: -2, bony: -2, frail: -2, weak: -2, sickly: -3, unhealthy: -2, pale: -1,
        ugly: -4, hideous: -4, gross: -3, disgusting: -4, creepy: -3, scary: -2, weird: -2, strange: -2,
        odd: -1, awkward: -2, nerdy: -1, dorky: -1, plain: -1, boring: -2, dull: -2, bland: -2,
        messy: -2, untidy: -2, sloppy: -2, scruffy: -2, dirty: -3, smelly: -3, greasy: -2, unkempt: -2,
        shabby: -2, tacky: -2, cheap: -2, old: -1, wrinkled: -1, tired: -2, exhausted: -2, sleepy: -1,
        sad: -2, gloomy: -2, depressed: -3, lonely: -2, cold: -2, distant: -2, unfriendly: -3, rude: -3,
        mean: -2, arrogant: -3, cocky: -2, smug: -2, snobby: -3, rich: 0, intimidating: -2, aggressive: -3,
        angry: -3, grumpy: -2, moody: -2, serious: -1, stiff: -1, nervous: -1, anxious: -2, insecure: -2,
        lazy: -3, sus: -2, suspicious: -2, shady: -2, fake: -3, dumb: -3, stupid: -3, unapproachable: -3,
        // positive
        handsome: 3, pretty: 3, beautiful: 3, cute: 3, gorgeous: 4, stunning: 4, attractive: 3, lovely: 3,
        stylish: 3, fashionable: 3, elegant: 3, classy: 3, neat: 2, tidy: 2, clean: 2, groomed: 2,
        fit: 2, athletic: 2, strong: 2, healthy: 2, sporty: 2, toned: 2, confident: 2, cool: 2,
        kind: 2, gentle: 2, warm: 2, sweet: 2, friendly: 2, approachable: 3, welcoming: 3, nice: 2,
        charming: 3, charismatic: 3, smart: 2, intelligent: 2, wise: 2, calm: 1, chill: 1, relaxed: 1,
        peaceful: 2, cheerful: 3, happy: 3, smiling: 2, bright: 2, fresh: 2, young: 1, youthful: 2,
        trustworthy: 3, honest: 2, reliable: 2, polite: 2, mature: 1, professional: 2, interesting: 2,
        unique: 2, creative: 2, funny: 2, fun: 2, energetic: 2, lively: 2, mysterious: 1,
    };
    const NEGATORS = new Set([
        'not', 'no', 'never', 'none', 'nor', 'neither', 'without', 'hardly', 'barely',
        "isn't", 'isnt', "aren't", 'arent', "wasn't", 'wasnt', "weren't", 'werent', "don't", 'dont',
        "doesn't", 'doesnt', "didn't", 'didnt', "can't", 'cant', 'cannot', "won't", 'wont', "wouldn't",
        'wouldnt', "shouldn't", 'shouldnt', "couldn't", 'couldnt', "ain't", 'aint',
    ]);
    const INTENSIFIERS = new Set(['so', 'very', 'really', 'extremely', 'super', 'too', 'totally', 'incredibly', 'quite', 'way', 'insanely', 'absolutely', 'such']);
    const SOFTENERS = new Set(['slightly', 'somewhat', 'kinda', 'little', 'bit', 'fairly', 'rather', 'sorta']);
    function wordScore(word) {
        if (word in APPEARANCE_WORDS) return APPEARANCE_WORDS[word];
        return sentiment.analyze(word).score;
    }
    /**
     * Scores a spoken impression. Besides the word list it understands:
     * - negation: "not friendly", "doesn't look kind", "never smiles" flip the meaning,
     * - intensifiers: "so fat", "very handsome" count stronger,
     * - softeners: "a bit messy", "kind of weird" count weaker,
     * - "but": in "fat but friendly" the part after "but" counts more.
     */
    function classifyTranscript(transcript) {
        const tokens = transcript.toLowerCase().replace(/[’]/g, "'").match(/[a-z']+/g) ?? [];
        let total = 0;
        const words = [];
        const butAt = tokens.lastIndexOf('but');
        tokens.forEach((token, i) => {
            if (INTENSIFIERS.has(token) || SOFTENERS.has(token) || NEGATORS.has(token)) return;
            // "kind of" / "sort of" are softeners, not the word "kind".
            if ((token === 'kind' || token === 'sort') && tokens[i + 1] === 'of') return;
            // "looks like a ..." compares, it is not the word "like".
            if (token === 'like' && ['look', 'looks', 'looked', 'seem', 'seems', 'feel', 'feels', 'sound', 'sounds', 'just', 'a'].includes(tokens[i - 1])) return;
            // "pretty handsome": 'pretty' is an intensifier when another describing word follows.
            if (token === 'pretty' && i + 1 < tokens.length && wordScore(tokens[i + 1]) !== 0) return;
            let score = wordScore(token);
            if (score === 0) return;
            const before = tokens.slice(Math.max(0, i - 3), i);
            if (before.some((t) => NEGATORS.has(t))) score = -Math.sign(score) * Math.max(1, Math.round(Math.abs(score) * 0.75));
            const prev = tokens[i - 1];
            const prev2 = tokens.slice(Math.max(0, i - 2), i).join(' ');
            if (INTENSIFIERS.has(prev) || (prev === 'pretty' && token !== 'pretty')) score += Math.sign(score);
            if (SOFTENERS.has(prev) || prev2 === 'kind of' || prev2 === 'sort of' || prev2 === 'a bit' || prev2 === 'a little') {
                score = Math.sign(score) * Math.max(1, Math.round(Math.abs(score) / 2));
            }
            if (butAt > i) score /= 2;
            total += score;
            words.push(token);
        });
        const category = total > 0 ? 'Positive' : total < 0 ? 'Negative' : 'Neutral';
        const score = Math.sign(total) * Math.max(Math.abs(total) > 0 ? 1 : 0, Math.round(Math.abs(total)));
        return { transcript, score, category, words };
    }
    function describeResult(result) {
        const score = result.score > 0 ? `+${result.score}` : `${result.score}`;
        const words = result.words?.length ? ` (${result.words.join(', ')})` : '';
        return `${result.category} · score ${score}${words}`;
    }
    class VoiceController {
        callbacks;
        recognition = null;
        active = false;
        resolved = false;
        stopRequested = false;
        constructor(callbacks) {
            this.callbacks = callbacks;
        }
        toggle() {
            if (this.active) {
                this.stop();
            }
            else {
                this.start();
            }
        }
        start() {
            // Never allow two recording sessions at the same time.
            if (this.active)
                return;
            const Recognition = getSpeechRecognitionConstructor();
            if (!Recognition) {
                this.callbacks.onStatus('Error', 'Speech recognition is not supported in this browser. Use the buttons below.');
                return;
            }
            const recognition = new Recognition();
            this.recognition = recognition;
            this.active = true;
            this.resolved = false;
            this.stopRequested = false;
            recognition.lang = RECOGNITION_LANG;
            recognition.continuous = false;
            recognition.interimResults = false;
            recognition.maxAlternatives = 1;
            recognition.onresult = (event) => {
                let transcript = '';
                for (let i = event.resultIndex; i < event.results.length; i += 1) {
                    const result = event.results[i];
                    if (result.isFinal)
                        transcript += result[0].transcript;
                }
                const text = transcript.trim();
                if (text)
                    void this.process(recognition, text);
            };
            recognition.onerror = (event) => {
                if (this.resolved)
                    return;
                this.resolved = true;
                this.release(recognition);
                this.callbacks.onStatus('Error', ERROR_MESSAGES[event.error] ?? 'Voice recognition failed. Press and speak again.');
            };
            recognition.onend = () => {
                if (this.resolved)
                    return;
                this.resolved = true;
                const stoppedByUser = this.stopRequested;
                this.release(recognition);
                this.callbacks.onStatus('Error', stoppedByUser ? 'Recording stopped. Press and speak again.' : 'No speech detected. Press and speak again.');
            };
            this.callbacks.onStatus('Listening...');
            try {
                recognition.start();
            }
            catch {
                this.resolved = true;
                this.release(recognition);
                this.callbacks.onStatus('Error', 'Could not start the microphone. Press and speak again.');
            }
        }
        stop() {
            if (!this.active || !this.recognition)
                return;
            this.stopRequested = true;
            try {
                this.recognition.stop();
            }
            catch {
                // Recognition already stopped.
            }
        }
        async process(recognition, transcript) {
            // Each recording is processed exactly once.
            if (this.resolved)
                return;
            this.resolved = true;
            this.release(recognition);
            this.callbacks.onTranscript(transcript);
            this.callbacks.onStatus('Analysing...');
            await new Promise((resolve) => setTimeout(resolve, 150));
            const result = classifyTranscript(transcript);
            this.callbacks.onResult(result);
            this.callbacks.onStatus('Result', describeResult(result));
        }
        release(recognition) {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            try {
                recognition.abort();
            }
            catch {
                // Recognition already stopped.
            }
            if (this.recognition === recognition)
                this.recognition = null;
            this.active = false;
        }
    }

    // ---------------------------------------------------------------------------
    // Laptop voice station link (headset <-> laptop)
    // ---------------------------------------------------------------------------
    // Link between the headset page and the laptop "voice station" page (index.html?station).
    // Meta Quest Browser has no working speech recognition, so in the headset
    // "Press and speak" asks the laptop to listen; the laptop's Chrome turns the
    // speech into text, classifies it and sends the result back.
    //
    // Both pages talk through a public MQTT broker over secure WebSocket, so nothing
    // has to be installed and the GitHub Pages (HTTPS) site can reach it.
    // Both pages must use the same broker and room. Override with ?room=... / ?broker=...
    const DEFAULT_BROKER = 'wss://broker.emqx.io:8084/mqtt';
    const DEFAULT_ROOM = 'chemical-welfare-who-are-you-g7';
    function readConfig() {
        const params = new URLSearchParams(window.location.search);
        return {
            broker: params.get('broker') || DEFAULT_BROKER,
            room: params.get('room') || DEFAULT_ROOM,
        };
    }
    function topics(room) {
        const base = `who-are-you/${room}`;
        return { command: `${base}/command`, event: `${base}/event`, station: `${base}/station` };
    }
    function connect(onConnection, will) {
        const { broker, room } = readConfig();
        onConnection('connecting');
        const client = mqtt.connect(broker, {
            clientId: `who-are-you-${Math.random().toString(16).slice(2, 10)}`,
            reconnectPeriod: 2000,
            connectTimeout: 8000,
            clean: true,
            will: will ? { topic: will.topic, payload: will.payload, retain: true, qos: 1 } : undefined,
        });
        client.on('connect', () => onConnection('connected'));
        client.on('offline', () => onConnection('offline'));
        client.on('close', () => onConnection('offline'));
        client.on('reconnect', () => onConnection('connecting'));
        return { client, room };
    }
    function parse(payload) {
        try {
            return JSON.parse(new TextDecoder().decode(payload));
        }
        catch {
            return null;
        }
    }
    /** Headset side: sends start/stop, receives status/transcript/result. */
    class HeadsetRelay {
        client;
        t;
        stationOnline = false;
        constructor(handlers) {
            const { client, room } = connect(handlers.onConnection);
            this.client = client;
            this.t = topics(room);
            client.on('connect', () => {
                client.subscribe([this.t.event, this.t.station], { qos: 1 });
            });
            client.on('message', (topic, payload) => {
                if (topic === this.t.station) {
                    this.stationOnline = new TextDecoder().decode(payload) === 'online';
                    handlers.onStation(this.stationOnline);
                    return;
                }
                const event = parse(payload);
                if (event)
                    handlers.onEvent(event);
            });
        }
        send(command) {
            this.client.publish(this.t.command, JSON.stringify(command), { qos: 1 });
        }
    }
    /** Laptop side: receives start/stop, sends status/transcript/result. */
    class StationRelay {
        client;
        t;
        room;
        broker;
        constructor(handlers) {
            const config = readConfig();
            this.room = config.room;
            this.broker = config.broker;
            const t = topics(config.room);
            const { client } = connect(handlers.onConnection, { topic: t.station, payload: 'offline' });
            this.client = client;
            this.t = t;
            client.on('connect', () => {
                client.publish(t.station, 'online', { retain: true, qos: 1 });
                client.subscribe(t.command, { qos: 1 });
            });
            client.on('message', (topic, payload) => {
                if (topic !== t.command)
                    return;
                const command = parse(payload);
                if (command)
                    handlers.onCommand(command);
            });
            window.addEventListener('beforeunload', () => {
                client.publish(t.station, 'offline', { retain: true, qos: 0 });
            });
        }
        send(event) {
            this.client.publish(this.t.event, JSON.stringify(event), { qos: 1 });
        }
    }
    /**
     * Drop-in for VoiceController in the headset: same callbacks, but the listening
     * happens on the laptop voice station.
     */
    class RemoteVoiceController {
        relay;
        active = false;
        answerTimer;
        callbacks;
        onStation;
        constructor(callbacks, onStation) {
            this.callbacks = callbacks;
            this.onStation = onStation;
            this.relay = new HeadsetRelay({
                onEvent: (event) => this.handle(event),
                onStation: (online) => {
                    if (!online && this.active) {
                        this.active = false;
                        this.callbacks.onStatus('Error', 'laptop voice station offline');
                    }
                    this.onStation(online);
                },
                onConnection: (state) => {
                    if (state !== 'connected')
                        this.onStation(false);
                },
            });
        }
        get stationOnline() {
            return this.relay.stationOnline;
        }
        toggle() {
            if (this.active) {
                this.relay.send({ type: 'stop' });
                return;
            }
            if (!this.relay.stationOnline) {
                this.callbacks.onStatus('Error', 'laptop voice station offline');
                return;
            }
            this.active = true;
            this.callbacks.onStatus('Listening...');
            this.relay.send({ type: 'start' });
            window.clearTimeout(this.answerTimer);
            this.answerTimer = window.setTimeout(() => {
                if (!this.active)
                    return;
                this.active = false;
                this.callbacks.onStatus('Error', 'no answer from the laptop. Try again.');
            }, 6000);
        }
        handle(event) {
            window.clearTimeout(this.answerTimer);
            if (event.type === 'status') {
                this.active = event.status === 'Listening...' || event.status === 'Analysing...';
                this.callbacks.onStatus(event.status, event.detail);
                if (event.status === 'Listening...') {
                    // The station may listen for a while; give up only if it never reports back.
                    this.answerTimer = window.setTimeout(() => {
                        if (!this.active)
                            return;
                        this.active = false;
                        this.callbacks.onStatus('Error', 'no answer from the laptop. Try again.');
                    }, 20000);
                }
            }
            else if (event.type === 'transcript') {
                this.callbacks.onTranscript(event.transcript);
            }
            else if (event.type === 'result') {
                this.active = false;
                this.callbacks.onResult(event.result);
            }
        }
    }

    // ---------------------------------------------------------------------------
    // In-world panel shown inside the headset
    // ---------------------------------------------------------------------------
    // The canvas is drawn at 1 CSS px = SCALE canvas px, so the CSS values from style.css can be reused.
    const SCALE = 3;
    const CSS_WIDTH = 590;
    const FONT_FAMILY = 'Inter, system-ui, Avenir, Helvetica, Arial, sans-serif';
    // Physical width of the panel in metres.
    const PANEL_WIDTH_M = 0.75;
    const STATUS_COLORS = {
        ready: 'rgba(255, 255, 255, 0.7)',
        listening: '#E88AB8',
        analysing: '#87CEEB',
        result: '#9be29b',
        error: '#ff8f8f',
    };
    class XRPanel {
        mesh;
        canvas;
        ctx;
        texture;
        buttons = [];
        hovered = null;
        pressed = null;
        pressedUntil = 0;
        statusText = 'Ready';
        statusState = 'ready';
        transcript = '';
        listening = false;
        voiceLabel = 'Press and speak';
        cssHeight = 260;
        constructor() {
            this.canvas = document.createElement('canvas');
            this.ctx = this.canvas.getContext('2d');
            this.texture = new THREE.CanvasTexture(this.canvas);
            this.texture.colorSpace = THREE.SRGBColorSpace;
            this.texture.anisotropy = 4;
            const material = new THREE.MeshBasicMaterial({
                map: this.texture,
                transparent: true,
                depthWrite: false,
                side: THREE.DoubleSide,
            });
            this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
            this.mesh.name = 'xr-panel';
            this.mesh.renderOrder = 10;
            this.redraw();
        }
        setStatus(text, state) {
            this.statusText = text;
            this.statusState = (state in STATUS_COLORS ? state : 'ready');
            this.redraw();
        }
        setTranscript(text) {
            this.transcript = text;
            this.redraw();
        }
        setListening(listening) {
            this.listening = listening;
            this.redraw();
        }
        setVoiceLabel(label) {
            this.voiceLabel = label;
            this.redraw();
        }
        /** Returns the action under a panel uv coordinate (from a raycast), or null. */
        actionAt(uv) {
            const x = uv.x * CSS_WIDTH;
            const y = (1 - uv.y) * this.cssHeight;
            const hit = this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
            return hit ? hit.action : null;
        }
        setHovered(action) {
            if (action === this.hovered)
                return;
            this.hovered = action;
            this.redraw();
        }
        /** Short pressed feedback, matching button:active { filter: brightness(0.8) }. */
        flashPressed(action) {
            this.pressed = action;
            this.pressedUntil = performance.now() + 180;
            this.redraw();
        }
        update(now) {
            if (this.pressed && now > this.pressedUntil) {
                this.pressed = null;
                this.redraw();
            }
            else if (this.listening) {
                // voice-pulse animation of #btn-voice.is-listening
                this.redraw(now);
            }
        }
        layout(ctx) {
            // Mirrors #ui-overlay: padding 20px, question 1.2rem bold, gap 10px buttons,
            // voice container margin/padding 16px with a top border.
            const padding = 20;
            const buttons = [];
            ctx.font = `bold 19.2px ${FONT_FAMILY}`;
            const questionLines = wrapText(ctx, "What is your first impression of this person's appearance?", CSS_WIDTH - padding * 2);
            let y = padding + questionLines.length * 28.8 + 20;
            ctx.font = `500 16px ${FONT_FAMILY}`;
            const choices = [
                ['Negative', 'Distant', '#263A72', 'white'],
                ['Neutral', 'Calm', '#87CEEB', '#333'],
                ['Positive', 'Friendly', '#E88AB8', 'white'],
            ];
            const widths = choices.map(([, label]) => ctx.measureText(label).width + 19.2 * 2);
            const total = widths.reduce((a, b) => a + b, 0) + 10 * (choices.length - 1);
            let x = (CSS_WIDTH - total) / 2;
            const buttonHeight = 16 * 1.5 + 9.6 * 2 + 2;
            choices.forEach(([action, label, background, color], i) => {
                buttons.push({ action, label, x, y, w: widths[i], h: buttonHeight, radius: 8, background, color });
                x += widths[i] + 10;
            });
            y += buttonHeight;
            const dividerY = y + 16;
            y = dividerY + 16;
            const voiceText = `🎙  ${this.voiceLabel}`;
            const voiceWidth = ctx.measureText(voiceText).width + 22.4 * 2;
            buttons.push({
                action: 'voice',
                label: voiceText,
                x: (CSS_WIDTH - voiceWidth) / 2,
                y,
                w: voiceWidth,
                h: buttonHeight,
                radius: buttonHeight / 2,
                background: this.listening ? '#b0335f' : '#6d3bd4',
                color: 'white',
            });
            y += buttonHeight + 10;
            ctx.font = `13.6px ${FONT_FAMILY}`;
            const statusLines = wrapText(ctx, this.statusText, CSS_WIDTH - padding * 2);
            const statusY = y;
            y += statusLines.length * 20.4;
            let transcriptLines = [];
            let transcriptY = y;
            if (this.transcript) {
                ctx.font = `italic 14.4px ${FONT_FAMILY}`;
                transcriptLines = wrapText(ctx, this.transcript, 320);
                transcriptY = y + 10;
                y = transcriptY + transcriptLines.length * 21.6;
            }
            return {
                padding,
                questionLines,
                buttons,
                dividerY,
                statusLines,
                statusY,
                transcriptLines,
                transcriptY,
                height: y + padding,
            };
        }
        redraw(now = performance.now()) {
            const measure = this.layout(this.ctx);
            this.cssHeight = Math.ceil(measure.height);
            this.buttons = measure.buttons;
            const width = CSS_WIDTH * SCALE;
            const height = this.cssHeight * SCALE;
            if (this.canvas.width !== width || this.canvas.height !== height) {
                this.canvas.width = width;
                this.canvas.height = height;
                this.texture.dispose();
                this.mesh.scale.set(PANEL_WIDTH_M, (PANEL_WIDTH_M * this.cssHeight) / CSS_WIDTH, 1);
            }
            const ctx = this.ctx;
            ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
            ctx.clearRect(0, 0, CSS_WIDTH, this.cssHeight);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            // Panel background: rgba(0,0,0,0.7), border-radius 12px
            roundRect(ctx, 0, 0, CSS_WIDTH, this.cssHeight, 12);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fill();
            // Thin edge so the panel reads clearly against bright passthrough rooms.
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.fillStyle = 'white';
            ctx.font = `bold 19.2px ${FONT_FAMILY}`;
            measure.questionLines.forEach((line, i) => {
                ctx.fillText(line, CSS_WIDTH / 2, measure.padding + 14.4 + i * 28.8);
            });
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(measure.padding, measure.dividerY);
            ctx.lineTo(CSS_WIDTH - measure.padding, measure.dividerY);
            ctx.stroke();
            ctx.font = `500 16px ${FONT_FAMILY}`;
            for (const b of measure.buttons) {
                if (b.action === 'voice' && this.listening) {
                    const phase = (Math.sin((now / 1200) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
                    roundRect(ctx, b.x - phase * 8, b.y - phase * 8, b.w + phase * 16, b.h + phase * 16, b.radius + phase * 8);
                    ctx.fillStyle = `rgba(232, 138, 184, ${0.6 * (1 - phase)})`;
                    ctx.fill();
                }
                ctx.save();
                if (this.pressed === b.action)
                    ctx.filter = 'brightness(0.8)';
                else if (this.hovered === b.action)
                    ctx.filter = 'brightness(1.2)';
                roundRect(ctx, b.x, b.y, b.w, b.h, b.radius);
                ctx.fillStyle = b.background;
                ctx.fill();
                if (b.action === 'voice') {
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
                    ctx.stroke();
                }
                ctx.restore();
                if (this.hovered === b.action) {
                    roundRect(ctx, b.x - 2, b.y - 2, b.w + 4, b.h + 4, b.radius + 2);
                    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
                    ctx.lineWidth = 2;
                    ctx.stroke();
                    ctx.lineWidth = 1;
                }
                ctx.fillStyle = b.color;
                ctx.fillText(b.label, b.x + b.w / 2, b.y + b.h / 2 + 1);
            }
            ctx.font = `13.6px ${FONT_FAMILY}`;
            ctx.fillStyle = STATUS_COLORS[this.statusState];
            measure.statusLines.forEach((line, i) => {
                ctx.fillText(line, CSS_WIDTH / 2, measure.statusY + 10.2 + i * 20.4);
            });
            if (measure.transcriptLines.length) {
                ctx.font = `italic 14.4px ${FONT_FAMILY}`;
                ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
                measure.transcriptLines.forEach((line, i) => {
                    ctx.fillText(line, CSS_WIDTH / 2, measure.transcriptY + 10.8 + i * 21.6);
                });
            }
            this.texture.needsUpdate = true;
        }
    }
    function roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.roundRect(x, y, w, h, Math.min(r, h / 2, w / 2));
    }
    function wrapText(ctx, text, maxWidth) {
        const words = text.split(/\s+/).filter(Boolean);
        const lines = [];
        let line = '';
        for (const word of words) {
            const candidate = line ? `${line} ${word}` : word;
            if (ctx.measureText(candidate).width > maxWidth && line) {
                lines.push(line);
                line = word;
            }
            else {
                line = candidate;
            }
        }
        if (line)
            lines.push(line);
        return lines.length ? lines : [''];
    }

    // ---------------------------------------------------------------------------
    // In-world question panel for immersive VR (Meta Quest)
    // ---------------------------------------------------------------------------
    // White, slightly transparent card with the question, the three impression buttons and the
    // "Press and Speak" button. The panel hangs to the left of the eye line so it never covers
    // the persona. World coordinates rely on the 'local-floor' origin: floor, start position,
    // facing -Z at session start.
    const VR_PANEL_WIDTH_M = 0.76;
    const VR_PANEL_HEIGHT_M = 0.318;
    const VR_PANEL_CSS_WIDTH = 600;
    const VR_PANEL_CSS_HEIGHT = 251;
    const VR_PANEL_POSITION = new THREE.Vector3(-0.68, 1.52, -1.18);
    const VR_PANEL_YAW = 0.35; // turns the panel back towards the participant
    const VR_QUESTION_TEXT = 'What is your first impression about this person?';
    const VR_QUESTION_FONT = `"Bitcount Single", ${FONT_FAMILY}`;
    const VR_BUTTON_FONT = `"DM Sans", ${FONT_FAMILY}`;
    const VR_CHOICES = [
        { action: 'Negative', label: 'Distant', background: '#263A72', color: '#ffffff' },
        { action: 'Neutral', label: 'Calm', background: '#87CEEB', color: '#333333' },
        { action: 'Positive', label: 'Friendly', background: '#E88AB8', color: '#ffffff' },
    ];
    const VR_VOICE_IDLE_BG = '#d9c7ff';
    const VR_VOICE_IDLE_TEXT = '#3b2a63';
    const VR_VOICE_PRESSED_BG = '#7bd88f';
    const VR_VOICE_PRESSED_TEXT = '#14532d';
    const VR_PRESSED_MS = 900;
    const vrCssToM = (css) => (VR_PANEL_WIDTH_M * css) / VR_PANEL_CSS_WIDTH;
    class VRQuestionPanel {
        group = new THREE.Group();
        card;
        cardCanvas;
        cardCtx;
        cardTexture;
        buttons = [];
        voice;
        hitTargets = [];
        hovered = null;
        pressedAction = null;
        pressedUntil = 0;
        constructor() {
            this.group.name = 'vr-question-panel';
            this.group.position.copy(VR_PANEL_POSITION);
            this.group.rotation.y = VR_PANEL_YAW;
            this.group.visible = false;
            this.createCard();
            const buttonWidth = vrCssToM(160);
            const buttonHeight = vrCssToM(60);
            const gap = vrCssToM(21);
            const totalWidth = buttonWidth * 3 + gap * 2;
            VR_CHOICES.forEach((choice, index) => {
                const button = this.createTextButton({
                    action: choice.action,
                    label: choice.label,
                    background: choice.background,
                    color: choice.color,
                    cssWidth: 160,
                    cssHeight: 60,
                    width: buttonWidth,
                    height: buttonHeight,
                    x: -totalWidth / 2 + buttonWidth / 2 + index * (buttonWidth + gap),
                    y: vrCssToM(-190),
                });
                this.buttons.push(button);
                this.hitTargets.push(button.mesh);
            });
            this.voice = this.createTextButton({
                action: 'voice',
                label: 'Press and Speak',
                background: VR_VOICE_IDLE_BG,
                color: VR_VOICE_IDLE_TEXT,
                cssWidth: 280,
                cssHeight: 70,
                width: vrCssToM(280),
                height: vrCssToM(70),
                x: 0,
                y: vrCssToM(-285),
            });
            this.hitTargets.push(this.voice.mesh);
            this.group.add(...this.hitTargets);
            void this.loadFonts();
        }
        createCard() {
            this.cardCanvas = document.createElement('canvas');
            this.cardCanvas.width = VR_PANEL_CSS_WIDTH * SCALE;
            this.cardCanvas.height = VR_PANEL_CSS_HEIGHT * SCALE;
            this.cardCtx = this.cardCanvas.getContext('2d');
            this.cardTexture = new THREE.CanvasTexture(this.cardCanvas);
            this.cardTexture.colorSpace = THREE.SRGBColorSpace;
            this.cardTexture.anisotropy = 4;
            this.card = new THREE.Mesh(
                new THREE.PlaneGeometry(VR_PANEL_WIDTH_M, VR_PANEL_HEIGHT_M),
                new THREE.MeshBasicMaterial({
                    map: this.cardTexture,
                    transparent: true,
                    depthWrite: false,
                    side: THREE.DoubleSide,
                }),
            );
            this.card.name = 'vr-question-card';
            this.card.renderOrder = 1;
            this.group.add(this.card);
            this.drawCard();
        }
        createTextButton({ action, label, background, color, cssWidth, cssHeight, width, height, x, y }) {
            const canvas = document.createElement('canvas');
            canvas.width = cssWidth * SCALE;
            canvas.height = cssHeight * SCALE;
            const ctx = canvas.getContext('2d');
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.anisotropy = 4;
            const face = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide });
            // Flat box: the textured face points at the participant, the thin edges stay solid.
            const edge = new THREE.MeshBasicMaterial({ color: background });
            const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.012), [edge, edge, edge, edge, face, edge]);
            mesh.name = `vr-button-${action}`;
            mesh.userData.action = action;
            mesh.position.set(x, y, 0);
            mesh.renderOrder = 2;
            const button = { action, label, background, color, canvas, ctx, texture, edge, mesh, cssWidth, cssHeight };
            this.drawButton(button);
            return button;
        }
        drawCard() {
            const ctx = this.cardCtx;
            const w = VR_PANEL_CSS_WIDTH;
            const h = VR_PANEL_CSS_HEIGHT;
            ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            roundRect(ctx, 1, 1, w - 2, h - 2, 22);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.fill();
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.fillStyle = '#000000';
            ctx.font = `700 36px ${VR_QUESTION_FONT}`;
            const lines = wrapText(ctx, VR_QUESTION_TEXT, w - 70);
            const lineHeight = 48;
            const startY = h / 2 - ((lines.length - 1) * lineHeight) / 2;
            lines.forEach((line, i) => ctx.fillText(line, w / 2, startY + i * lineHeight));
            this.cardTexture.needsUpdate = true;
        }
        drawButton(button) {
            const { ctx, cssWidth: w, cssHeight: h } = button;
            const hovered = this.hovered === button.action;
            const pressed = this.pressedAction === button.action;
            const voice = button.action === 'voice';
            const fill = pressed ? (voice ? VR_VOICE_PRESSED_BG : '#7bd88f') : button.background;
            ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
            ctx.clearRect(0, 0, w, h);
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            roundRect(ctx, 0, 0, w, h, Math.min(14, h / 2));
            ctx.fillStyle = fill;
            ctx.fill();
            if (hovered && !pressed) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
                ctx.fill();
            }
            if (hovered || pressed) {
                ctx.strokeStyle = pressed ? 'rgba(20, 83, 45, 0.85)' : 'rgba(255, 255, 255, 0.95)';
                ctx.lineWidth = 3;
                ctx.stroke();
            }
            ctx.fillStyle = pressed ? (voice ? VR_VOICE_PRESSED_TEXT : '#14401f') : button.color;
            ctx.font = `700 ${voice ? 28 : 26}px ${VR_BUTTON_FONT}`;
            ctx.fillText(button.label, w / 2, h / 2 + 1);
            button.texture.needsUpdate = true;
            button.edge.color.set(fill);
        }
        /** Returns the button under a controller ray, or null. */
        hitAt(raycaster) {
            const hit = raycaster.intersectObjects(this.hitTargets, false)[0];
            if (!hit) return null;
            return { action: hit.object.userData.action, point: hit.point, distance: hit.distance };
        }
        setHovered(action) {
            if (action === this.hovered) return;
            this.hovered = action;
            this.redraw();
        }
        flashPressed(action) {
            this.pressedAction = action;
            this.pressedUntil = performance.now() + VR_PRESSED_MS;
            this.redraw();
        }
        update(now) {
            if (!this.pressedAction || now < this.pressedUntil) return;
            this.pressedAction = null;
            this.redraw();
        }
        redraw() {
            for (const button of [...this.buttons, this.voice]) {
                if (button) this.drawButton(button);
            }
        }
        show() {
            this.group.visible = true;
        }
        hide() {
            this.group.visible = false;
            this.hovered = null;
            this.pressedAction = null;
            this.redraw();
        }
        async loadFonts() {
            if (!document.fonts?.load) return;
            try {
                await Promise.all([
                    document.fonts.load(`700 36px "Bitcount Single"`),
                    document.fonts.load(`700 28px "DM Sans"`),
                ]);
            }
            catch {
                // Keep the system fallback when the web fonts cannot be loaded.
            }
            this.drawCard();
            this.redraw();
        }
    }

    // ---------------------------------------------------------------------------
    // Installation page (index.html)
    // ---------------------------------------------------------------------------
    // AR uses the 'local-floor' reference space: its origin is on the floor under the
    // headset when the session starts, facing the way the participant looked.
    // The persona is placed once at a fixed spot in that space and never moves afterwards,
    // so it stays put while the participant walks around (no hit-test, no head-following).
    const AR_MODEL_DISTANCE = 1.5; // metres in front of the starting position
    const AR_MODEL_SCALE = 0.6;
    // The in-world panel sits above the persona, like the HTML panel sits above it on screen.
    const AR_PANEL_HEIGHT = 1.55; // metres above the floor (panel centre)
    const AR_PANEL_DISTANCE = 1.35; // slightly in front of the persona
    const PATCH_GROW_MS = 600;
    // Patches are 0.075 x 0.038 m; two patches never overlap while their centres are further
    // apart than the sum of their half-diagonals.
    const PATCH_HALF_DIAGONAL = 0.043;
    const PATCH_CORNERS = [[-0.0375, -0.019], [0.0375, -0.019], [-0.0375, 0.019], [0.0375, 0.019], [0, 0]];
    // Per body part: patch size (1 = full) and how far it sits off the surface, so a flat patch
    // on a curved part never sinks into the body.
    const PART_FIT = {
        head: { size: 0.7, lift: 0.01 }, nose: { size: 0.55, lift: 0.012 }, ear: { size: 0.5, lift: 0.012 },
        neck: { size: 0.7, lift: 0.011 }, torso: { size: 0.85, lift: 0.009 }, shoulder: { size: 0.75, lift: 0.011 },
        'upper-arm': { size: 0.6, lift: 0.011 }, forearm: { size: 0.55, lift: 0.011 }, hand: { size: 0.45, lift: 0.013 },
        thigh: { size: 0.75, lift: 0.01 }, calf: { size: 0.65, lift: 0.011 }, foot: { size: 0.5, lift: 0.013 },
    };
    const BODY_PARTS = Object.keys(PART_FIT);
    const FACE = ['head', 'nose'];
    // Where each spot on the persona is: an anchor point (persona coordinates, on the front of the
    // body; one per side for paired parts) and the body parts a patch for it may sit on.
    const SPOTS = {
        face: { anchors: [[0, 1.62, 0.11]], parts: FACE },
        eyes: { anchors: [[-0.04, 1.66, 0.1], [0.04, 1.66, 0.1]], parts: FACE },
        mouth: { anchors: [[0, 1.585, 0.1]], parts: FACE },
        nose: { anchors: [[0, 1.62, 0.13]], parts: ['nose', 'head'] },
        hair: { anchors: [[0, 1.75, 0.02]], parts: ['head'] },
        forehead: { anchors: [[0, 1.705, 0.09]], parts: ['head'] },
        chin: { anchors: [[0, 1.535, 0.08]], parts: ['head'] },
        cheeks: { anchors: [[-0.065, 1.6, 0.085], [0.065, 1.6, 0.085]], parts: FACE },
        ears: { anchors: [[-0.105, 1.635, 0.01], [0.105, 1.635, 0.01]], parts: ['ear', 'head'] },
        neck: { anchors: [[0, 1.47, 0.05]], parts: ['neck'] },
        shoulders: { anchors: [[-0.19, 1.405, 0.03], [0.19, 1.405, 0.03]], parts: ['shoulder', 'torso', 'upper-arm'] },
        chest: { anchors: [[0, 1.3, 0.115]], parts: ['torso'] },
        torso: { anchors: [[0, 1.18, 0.1]], parts: ['torso'] },
        belly: { anchors: [[0, 1.05, 0.095]], parts: ['torso'] },
        hips: { anchors: [[-0.15, 0.93, 0.07], [0.15, 0.93, 0.07]], parts: ['torso', 'thigh'] },
        arms: { anchors: [[-0.23, 1.24, 0.035], [0.23, 1.24, 0.035]], parts: ['upper-arm', 'forearm', 'shoulder'] },
        elbows: { anchors: [[-0.245, 1.1, 0.04], [0.245, 1.1, 0.04]], parts: ['upper-arm', 'forearm'] },
        hands: { anchors: [[-0.28, 0.82, 0.055], [0.28, 0.82, 0.055]], parts: ['hand', 'forearm'] },
        legs: { anchors: [[-0.09, 0.68, 0.075], [0.09, 0.68, 0.075]], parts: ['thigh', 'calf'] },
        knees: { anchors: [[-0.09, 0.47, 0.065], [0.09, 0.47, 0.065]], parts: ['thigh', 'calf'] },
        calves: { anchors: [[-0.095, 0.28, 0.06], [0.095, 0.28, 0.06]], parts: ['calf'] },
        feet: { anchors: [[-0.1, 0.045, 0.12], [0.1, 0.045, 0.12]], parts: ['foot', 'calf'] },
    };
    const words = (list) => new RegExp(`\\b(${list})\\b`);
    // 1) Body parts named directly. The first one mentioned wins.
    const PART_WORDS = [
        ['eyes', words('eyes?|eyebrows?|brows?|eyelashes|lashes|stares?|stared|staring|gaze|glare|glance')],
        ['mouth', words('mouth|lips?|smiles?|smiling|grin|grinning|teeth|tooth|frown|frowning')],
        ['nose', words('nose|nostrils?')],
        ['hair', words('hair|hairstyle|haircut|bald|curly|curls|ponytail|fringe|bangs|head')],
        ['forehead', words('forehead|wrinkles?')],
        ['chin', words('chin|jaw|jawline|beard|moustache|mustache|stubble')],
        ['cheeks', words('cheeks?|dimples?|freckles?|blush|blushing')],
        ['ears', words('ears?|earrings?')],
        ['face', words('face|faces|facial|expression|complexion|skin|makeup|glasses')],
        ['neck', words('neck|throat|necklace|collar')],
        ['shoulders', words('shoulders?')],
        ['chest', words('chest|breasts?|pecs|shirt|t-shirt|tshirt|top|jacket|coat|hoodie|sweater|dress|back')],
        ['belly', words('belly|bellies|stomach|tummy|gut|abs|waist|waistline|six-pack|navel|belt')],
        ['hips', words('hips?|butt|bum|bottom')],
        ['elbows', words('elbows?')],
        ['hands', words('hands?|fingers?|wrists?|palms?|nails?|fists?|gloves?|rings?')],
        ['arms', words('arms?|biceps?|forearms?|sleeves?')],
        ['knees', words('knees?')],
        ['calves', words('calf|calves|ankles?|shins?')],
        ['legs', words('legs?|thighs?|pants|jeans|trousers|shorts|skirt|leggings')],
        ['feet', words('foot|feet|toes?|shoes?|sneakers?|boots?|heels?|socks?|sandals?')],
    ];
    // 2) Describing words that people link with a part of the body ("so fat" -> belly).
    const ASSOCIATIONS = [
        ['belly', words('fat|fatty|chubby|overweight|obese|plump|bloated|flabby|heavy|heavyset|chunky|weight|beer|skinny|thin|slim|slender|bony|scrawny|lean')],
        ['arms', words('muscular|muscles?|strong|buff|ripped|athletic|toned|fit|weak|frail|scrawny|tattoos?|tattooed')],
        ['legs', words('tall|short|lanky|petite|tiny|giant|height|long-legged')],
        ['shoulders', words('posture|stiff|slouch|slouching|slouchy|hunched|upright|stance|tense|broad')],
        ['chest', words('outfit|clothes|clothing|dressed|style|stylish|fashion|fashionable|wearing|wears|uniform|suit')],
        ['mouth', words('smiley|laughing|laugh|cheerful|grumpy|pouting')],
        ['eyes', words('sleepy|tired|exhausted|suspicious|sus|shady|curious|intense')],
    ];
    /**
     * Which spot of the persona an impression talks about, from what was said:
     * a named body part, else a describing word linked to a part, else the body in
     * general (torso), else the face.
     */
    function regionFromTranscript(transcript) {
        const text = (transcript || '').toLowerCase();
        const first = (table) => {
            let found = null;
            for (const [spot, pattern] of table) {
                const match = pattern.exec(text);
                if (match && (!found || match.index < found.index)) found = { spot, index: match.index };
            }
            return found?.spot ?? null;
        };
        const named = first(PART_WORDS);
        if (named) return named;
        const linked = first(ASSOCIATIONS);
        if (linked) return linked;
        // 3) "body" on its own means the body in general: the middle of the torso.
        if (/\b(body|bodies|figure|build|built|shape|physique|frame|silhouette)\b/.test(text)) return 'torso';
        return 'face';
    }
    // Meta Quest Browser exposes no working speech recognition, so it uses the laptop voice station.
    function useLaptopVoiceStation() {
        const forced = new URLSearchParams(window.location.search).get('voice');
        if (forced === 'laptop')
            return true;
        if (forced === 'local')
            return false;
        return /OculusBrowser|Quest/i.test(navigator.userAgent) || !isSpeechRecognitionSupported();
    }
    class App {
        scene;
        camera;
        renderer;
        persona;
        uiOverlay;
        arExitButton;
        pendingARPlacement = false;
        arSessionActive = false;
        xrPanel = new XRPanel();
        vrPanel = new VRQuestionPanel();
        vrSessionActive = false;
        controllers = [];
        raycaster = new THREE.Raycaster();
        growingPatches = [];
        patches = [];
        vr = null;
        constructor() {
            const appElement = document.getElementById('app');
            if (!appElement)
                return;
            this.scene = new THREE.Scene();
            // Transparent scene so the real-world passthrough stays visible in AR.
            // In flat mode the dark background comes from the page CSS instead.
            this.scene.background = null;
            this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
            this.camera.position.set(0, 1.4, 2);
            this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
            this.renderer.setClearColor(0x000000, 0);
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.renderer.xr.enabled = true;
            appElement.appendChild(this.renderer.domElement);
            this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
            this.renderer.toneMappingExposure = 1.05;
            // Lights: soft sky/ground fill, the original key light, and a faint cool rim
            // (Calm blue) from behind so the silhouette separates from the background.
            const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x3a3a46, 1.1);
            this.scene.add(hemisphereLight);
            const directionalLight = new THREE.DirectionalLight(0xffffff, 1.6);
            directionalLight.position.set(5, 10, 7.5);
            this.scene.add(directionalLight);
            const rimLight = new THREE.DirectionalLight(0x87ceeb, 1.2);
            rimLight.position.set(-4, 5, -6);
            this.scene.add(rimLight);
            this.persona = new PersonaModel();
            this.scene.add(this.persona.mesh);
            this.xrPanel.mesh.visible = false;
            this.scene.add(this.xrPanel.mesh);
            this.scene.add(this.vrPanel.group);
            this.initUI();
            this.frameCamera();
            new ResizeObserver(() => this.frameCamera()).observe(this.uiOverlay);
            this.initAR();
            this.initVR();
            this.animate();
            window.addEventListener('resize', () => this.onWindowResize());
        }
        initUI() {
            const overlay = document.createElement('div');
            overlay.id = 'ui-overlay';
            overlay.innerHTML = `
          <div class="question">What is your first impression of this person's appearance?</div>
          <div class="button-container">
            <button id="btn-negative">Distant</button>
            <button id="btn-neutral">Calm</button>
            <button id="btn-positive">Friendly</button>
          </div>
          <div class="voice-container">
            <button id="btn-voice" type="button" aria-pressed="false" aria-describedby="voice-status">
              <span aria-hidden="true">🎙</span> Press and speak
            </button>
            <div id="voice-status" class="voice-status" data-state="ready" role="status" aria-live="polite">Ready</div>
            <div id="voice-transcript" class="voice-transcript" hidden></div>
          </div>
          <div class="ar-container">
            <button id="btn-exit-ar" type="button" hidden>Exit AR</button>
            <div id="ar-status" class="ar-status" data-state="ready" role="status" aria-live="polite"></div>
          </div>
        `;
            document.body.appendChild(overlay);
            this.uiOverlay = overlay;
            this.arExitButton = document.getElementById('btn-exit-ar');
            document.getElementById('btn-negative').addEventListener('click', () => this.addPatch('Negative'));
            document.getElementById('btn-neutral').addEventListener('click', () => this.addPatch('Neutral'));
            document.getElementById('btn-positive').addEventListener('click', () => this.addPatch('Positive'));
            this.initVoice();
        }
        // Controller rays (and hand-tracking pinch, which Quest reports as the same 'select')
        // let participants press the in-world panel buttons.
        initXRInput() {
            const rayGeometry = new THREE.BufferGeometry().setFromPoints([
                new THREE.Vector3(0, 0, 0),
                new THREE.Vector3(0, 0, -1),
            ]);
            const rayMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 });
            for (let i = 0; i < 2; i += 1) {
                const controller = this.renderer.xr.getController(i);
                const ray = new THREE.Line(rayGeometry, rayMaterial);
                ray.name = 'ray';
                ray.scale.z = 2;
                ray.visible = false;
                controller.add(ray);
                const cursor = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
                cursor.name = 'cursor';
                cursor.visible = false;
                this.scene.add(cursor);
                controller.userData.cursor = cursor;
                controller.addEventListener('connected', (event) => {
                    const source = event.data;
                    // Gaze/screen inputs have no ray to draw.
                    ray.visible = source.targetRayMode === 'tracked-pointer';
                    controller.userData.active = true;
                });
                controller.addEventListener('disconnected', () => {
                    ray.visible = false;
                    cursor.visible = false;
                    controller.userData.active = false;
                });
                controller.addEventListener('select', () => {
                    if (this.vrSessionActive) {
                        const hit = this.intersectVRPanel(controller);
                        if (hit?.action)
                            this.handleVRPanelAction(hit.action);
                        return;
                    }
                    const action = this.panelActionFor(controller);
                    if (action)
                        this.handlePanelAction(action);
                });
                this.scene.add(controller);
                this.controllers.push(controller);
            }
        }
        panelActionFor(controller) {
            const hit = this.intersectPanel(controller);
            return hit?.uv ? this.xrPanel.actionAt(hit.uv) : null;
        }
        intersectPanel(controller) {
            if (!this.xrPanel.mesh.visible || !controller.userData.active)
                return null;
            controller.updateMatrixWorld();
            this.raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
            this.raycaster.ray.direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
            return this.raycaster.intersectObject(this.xrPanel.mesh, false)[0] ?? null;
        }
        intersectVRPanel(controller) {
            if (!this.vrSessionActive || !this.vrPanel.group.visible || !controller.userData.active)
                return null;
            controller.updateMatrixWorld();
            this.raycaster.setFromXRController(controller);
            return this.vrPanel.hitAt(this.raycaster);
        }
        /** Hit on the AR panel, with the button action under the ray. */
        xrPanelHit(controller) {
            const hit = this.intersectPanel(controller);
            if (!hit)
                return null;
            return { point: hit.point, distance: hit.distance, action: hit.uv ? this.xrPanel.actionAt(hit.uv) : null };
        }
        updateXRInput() {
            let hovered = null;
            for (const controller of this.controllers) {
                const cursor = controller.userData.cursor;
                const ray = controller.getObjectByName('ray');
                const hit = this.vrSessionActive ? this.intersectVRPanel(controller) : this.xrPanelHit(controller);
                if (hit) {
                    cursor.position.copy(hit.point);
                    cursor.visible = true;
                    if (ray)
                        ray.scale.z = hit.distance;
                    if (hit.action)
                        hovered = hit.action;
                }
                else {
                    cursor.visible = false;
                    if (ray)
                        ray.scale.z = 2;
                }
            }
            if (this.vrSessionActive)
                this.vrPanel.setHovered(hovered);
            else
                this.xrPanel.setHovered(hovered);
        }
        handlePanelAction(action) {
            this.xrPanel.flashPressed(action);
            if (action === 'voice') {
                document.getElementById('btn-voice').click();
            }
            else {
                this.addPatch(action);
            }
        }
        handleVRPanelAction(action) {
            this.vrPanel.flashPressed(action);
            if (action === 'voice') {
                console.log('Voice button pressed');
                this.startSpeechRecognition();
            }
            else {
                this.addPatch(action);
            }
        }
        /** Starts listening from the in-world voice button (never stops an active recording). */
        startSpeechRecognition() {
            const micButton = document.getElementById('btn-voice');
            if (!micButton || micButton.disabled)
                return;
            const status = document.getElementById('voice-status');
            if (status?.dataset.state === 'listening')
                return;
            micButton.click();
        }
        initAR() {
            this.renderer.xr.setReferenceSpaceType('local-floor');
            this.initXRInput();
            const arButton = ARButton.createButton(this.renderer, {
                requiredFeatures: ['local-floor'],
                optionalFeatures: ['dom-overlay', 'hand-tracking'],
                // Reuse the existing UI as the AR dom-overlay so it stays usable in the session.
                domOverlay: { root: this.uiOverlay },
            });
            document.body.appendChild(arButton);
            this.arExitButton.addEventListener('click', () => {
                void this.renderer.xr.getSession()?.end();
            });
            this.renderer.xr.addEventListener('sessionstart', () => {
                const session = this.renderer.xr.getSession();
                // AR and VR share this event. Only passthrough (AR) sessions use the AR panel
                // and scaled AR placement; an opaque session is immersive VR.
                if (session?.environmentBlendMode === 'opaque') return;
                this.arSessionActive = true;
                // The viewer pose is only valid on the first XR frame, so placement is deferred.
                this.pendingARPlacement = true;
                this.arExitButton.hidden = false;
                // Quest Browser does not support dom-overlay, so the HTML panel is not shown in the
                // headset. Show the in-world copy of the panel instead (unless dom-overlay is active).
                this.xrPanel.mesh.visible = !session?.domOverlayState;
            });
            this.renderer.xr.addEventListener('sessionend', () => {
                if (!this.arSessionActive) return;
                this.arSessionActive = false;
                this.pendingARPlacement = false;
                this.arExitButton.hidden = true;
                this.xrPanel.mesh.visible = false;
                this.resetPersonaPlacement();
                // ARButton hides the dom-overlay root when a session ends; restore the normal UI.
                this.uiOverlay.style.display = '';
            });
            void this.reportARSupport();
        }
        async reportARSupport() {
            const status = document.getElementById('ar-status');
            const showFallback = (message) => {
                status.textContent = message;
                status.dataset.state = 'error';
            };
            if (!navigator.xr) {
                showFallback('AR works in Meta Quest Browser.');
                return;
            }
            try {
                const supported = await navigator.xr.isSessionSupported('immersive-ar');
                if (!supported) {
                    showFallback('AR works in Meta Quest Browser.');
                    return;
                }
                status.textContent = '';
                status.dataset.state = 'ready';
            }
            catch {
                showFallback('AR works in Meta Quest Browser.');
            }
        }
        // Immersive VR reuses the same scene, renderer and controllers as AR. The shared
        // vr module adds the Enter VR button, ambient audio and the 3D volume slider.
        async initVR() {
            const container = document.createElement('div');
            container.className = 'vr-container';
            container.innerHTML = `
              <button id="btn-exit-vr" type="button" hidden>Exit VR</button>
              <div id="vr-status" class="vr-status" data-state="ready" role="status" aria-live="polite"></div>
            `;
            this.uiOverlay.appendChild(container);

            const { VRExperience } = await import('./vr/index.js').catch((error) => {
                // file:// pages cannot load local ES modules; VR needs HTTP/HTTPS anyway.
                console.warn('VR module could not load:', error);
                const status = container.querySelector('.vr-status');
                if (status) {
                    status.textContent = 'VR needs the page served over HTTP/HTTPS so the vr module can load.';
                    status.dataset.state = 'error';
                }
                return {};
            });
            if (!VRExperience) return;
            const vr = new VRExperience(this.scene, this.camera, this.renderer, {
                overlayRoot: this.uiOverlay,
                // initXRInput() already created these for AR; reuse them for the slider.
                controllers: this.controllers,
                referenceSpaceType: 'local-floor',
                sliderPosition: new THREE.Vector3(1.5, 1.7, -1.45),
                initialVolume: 0.3,
                ambientSoundUrl: 'ambient sound.mp3',
                speakerIconUrl: 'speaker.svg',
                statusElement: document.getElementById('vr-status'),
                exitButton: document.getElementById('btn-exit-vr'),
                onSessionStart: () => {
                    // Stand the persona on the floor 1.5 m ahead, at full size, like the
                    // original VR scene. AR keeps its own scaled placement.
                    this.persona.mesh.position.set(0, 0, -1.5);
                    this.persona.mesh.rotation.set(0, 0, 0);
                    this.persona.mesh.scale.setScalar(1);
                    // The in-world panel is only shown during actual VR sessions.
                    this.vrSessionActive = true;
                    this.vrPanel.show();
                },
                onSessionEnd: () => {
                    this.vrSessionActive = false;
                    this.vrPanel.hide();
                    this.resetPersonaPlacement();
                    this.frameCamera();
                },
            });
            // ARButton already sits at bottom: 20px; keep the VR button clear of it.
            if (vr.button) vr.button.style.bottom = '70px';
            this.vr = vr;
        }
        initVoice() {
            const micButton = document.getElementById('btn-voice');
            const statusElement = document.getElementById('voice-status');
            const transcriptElement = document.getElementById('voice-transcript');
            const showStatus = (status, detail) => {
                const state = status.toLowerCase().replace(/[^a-z]/g, '');
                const text = detail ? `${status} — ${detail}` : status;
                statusElement.dataset.state = state;
                statusElement.textContent = text;
                this.xrPanel.setStatus(text, state);
            };
            const callbacks = {
                onStatus: (status, detail) => {
                    showStatus(status, detail);
                    if (status === 'Listening...') {
                        transcriptElement.hidden = true;
                        transcriptElement.textContent = '';
                    }
                    if (status === 'Listening...')
                        this.xrPanel.setTranscript('');
                    const listening = status === 'Listening...';
                    micButton.classList.toggle('is-listening', listening);
                    micButton.setAttribute('aria-pressed', String(listening));
                    this.xrPanel.setListening(listening);
                },
                onTranscript: (transcript) => {
                    transcriptElement.hidden = false;
                    transcriptElement.textContent = `"${transcript}"`;
                    this.xrPanel.setTranscript(`"${transcript}"`);
                },
                onResult: (result) => this.addPatch(result.category, result.transcript),
            };
            if (useLaptopVoiceStation()) {
                showStatus('Ready');
                let lastOnline = null;
                const remote = new RemoteVoiceController(callbacks, (online) => {
                    if (online === lastOnline)
                        return;
                    lastOnline = online;
                    if (statusElement.dataset.state === 'listening' || statusElement.dataset.state === 'analysing')
                        return;
                    if (online)
                        showStatus('Ready');
                    else
                        showStatus('Error', 'laptop voice station offline');
                });
                micButton.addEventListener('click', () => remote.toggle());
                return;
            }
            const voice = new VoiceController(callbacks);
            if (!isSpeechRecognitionSupported()) {
                micButton.disabled = true;
                micButton.textContent = '🎙 Voice unavailable';
                this.xrPanel.setVoiceLabel('Voice unavailable');
                showStatus('Error', 'Speech recognition is not supported in this browser. Use the buttons above.');
                return;
            }
            micButton.addEventListener('click', () => voice.toggle());
        }
        /**
         * Adds one impression patch where the impression points: a named body part ("his hands"
         * -> hands), a part people link with the words ("so fat" -> belly), the body in general
         * (torso), or else the face. It lands on the closest free spot to that point.
         */
        addPatch(category, transcript = '') {
            const region = regionFromTranscript(transcript);
            const spot = this.findFreePatchSpot(region);
            const patch = PatchGenerator.createPatch(category);
            const size = PART_FIT[spot.part]?.size ?? 1;
            patch.position.copy(spot.position);
            patch.quaternion.copy(spot.quaternion); // faces out of the body, tilted like a bandage
            patch.userData.size = size;
            patch.userData.part = spot.part;
            patch.userData.region = region;
            // Attach to the persona so patches follow it when it is placed in front of the user in AR.
            patch.scale.setScalar(0.001);
            this.persona.mesh.add(patch);
            this.patches.push(patch);
            this.growingPatches.push({ mesh: patch, born: performance.now(), size });
        }
        /**
         * Finds a free spot on the outside of the wanted body parts. Spots come from rays cast at
         * the front and sides of the body; a spot only counts if the ray hits that part first, so a
         * patch never ends up hidden behind or inside another part. Spots must keep a gap to every
         * existing patch, so patches never overlap. When the wanted parts are full, the patch moves
         * on to the rest of the body.
         */
        findFreePatchSpot(region) {
            const model = this.persona.mesh;
            model.updateMatrixWorld(true);
            const toLocal = model.matrixWorld.clone().invert();
            const allParts = this.persona.skinParts;
            const raycaster = new THREE.Raycaster();
            const probe = new THREE.Object3D(); // stand-in patch used to test each spot
            model.add(probe);
            const spotInfo = SPOTS[region] ?? SPOTS.face;
            const patchRadius = (part) => PATCH_HALF_DIAGONAL * (PART_FIT[part]?.size ?? 1);
            // Positive when the spot is free: room left after both patches' half-diagonals.
            const room = (c) => this.patches.reduce(
                (min, p) => Math.min(min, p.position.distanceTo(c.position) - patchRadius(c.part) - PATCH_HALF_DIAGONAL * p.userData.size),
                Infinity,
            );
            // Look at points around the anchor from the front (or the outer side for parts on the
            // left/right), and keep spots on the allowed parts that are clear and free.
            const sample = (anchor, radius, partNames, count) => {
                const found = [];
                const side = Math.sign(anchor.x) * Math.min(1, Math.abs(anchor.x) * 4);
                for (let i = 0; i < count; i += 1) {
                    const aim = anchor.clone().add(new THREE.Vector3().randomDirection().multiplyScalar(radius * Math.cbrt(Math.random())));
                    const yaw = side * 0.6 + (Math.random() - 0.5) * 0.6;
                    const pitch = (Math.random() - 0.5) * 0.4;
                    const dirLocal = new THREE.Vector3(-Math.sin(yaw), pitch, -Math.cos(yaw)).normalize();
                    const origin = aim.clone().addScaledVector(dirLocal, -2).applyMatrix4(model.matrixWorld);
                    raycaster.set(origin, dirLocal.clone().transformDirection(model.matrixWorld));
                    const hit = raycaster.intersectObjects(allParts, false)[0];
                    if (!hit || !hit.face || !partNames.includes(hit.object.name)) continue;
                    const normal = hit.face.normal.clone()
                        .applyNormalMatrix(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld))
                        .transformDirection(toLocal);
                    if (normal.z < -0.2) continue; // keep patches on the side people look at
                    const part = hit.object.name;
                    const position = hit.point.clone().applyMatrix4(toLocal).addScaledVector(normal, PART_FIT[part]?.lift ?? 0.01);
                    // Orientation: facing out of the body, with a random 'bandage' tilt.
                    probe.position.copy(position);
                    probe.quaternion.identity();
                    probe.lookAt(position.clone().add(normal));
                    probe.rotateZ((Math.random() - 0.5) * Math.PI / 2);
                    probe.scale.setScalar(PART_FIT[part]?.size ?? 1);
                    if (!this.isPatchSpotClear(probe, allParts, raycaster)) continue;
                    const candidate = { part, normal, position, quaternion: probe.quaternion.clone(), distance: position.distanceTo(anchor) };
                    if (room(candidate) >= 0.004) found.push(candidate);
                }
                return found;
            };
            // Paired parts (eyes, hands, legs...): start with the side that has fewer patches.
            const anchors = spotInfo.anchors.map((a) => new THREE.Vector3(...a)).sort((a, b) => {
                const near = (v) => this.patches.filter((p) => p.position.distanceTo(v) < 0.12).length;
                return near(a) - near(b);
            });
            // Grow outwards from the anchor: the closest free spot wins. First only on the named
            // parts, then (when those are full) on any part, still as close as possible.
            const closest = (list) => list.reduce((a, c) => (c.distance < a.distance ? c : a));
            let spot = null;
            for (const [partNames, radii] of [[spotInfo.parts, [0.03, 0.06, 0.1, 0.16, 0.24, 0.35, 0.5]], [BODY_PARTS, [0.3, 0.45, 0.7, 1]]]) {
                for (const radius of radii) {
                    for (const anchor of anchors) {
                        const found = sample(anchor, radius, partNames, 70);
                        if (found.length) {
                            spot = closest(found);
                            break;
                        }
                    }
                    if (spot) break;
                }
                if (spot) break;
            }
            model.remove(probe);
            return spot ?? {
                part: 'head', normal: new THREE.Vector3(0, 0, 1), position: new THREE.Vector3(0, 1.635, 0.14), quaternion: new THREE.Quaternion(),
            };
        }
        /**
         * A spot is clear when the whole patch sits outside the body (all four corners above the
         * surface) and nothing else of the body covers it.
         */
        isPatchSpotClear(probe, parts, raycaster) {
            probe.updateMatrixWorld(true);
            const out = new THREE.Vector3(0, 0, 1).transformDirection(probe.matrixWorld);
            const into = out.clone().negate();
            const centre = probe.getWorldPosition(new THREE.Vector3());
            raycaster.set(centre.clone().addScaledVector(out, 0.5), into);
            const cover = raycaster.intersectObjects(parts, false)[0];
            if (cover && cover.distance < 0.5) return false;
            for (const [x, y] of PATCH_CORNERS) {
                const corner = new THREE.Vector3(x, y, -0.004).applyMatrix4(probe.matrixWorld);
                raycaster.set(corner.addScaledVector(out, 0.2), into);
                const hit = raycaster.intersectObjects(parts, false)[0];
                if (hit && hit.distance < 0.2 + 0.001) return false;
            }
            return true;
        }
        // New patches grow in with a small overshoot so the participant sees their contribution land.
        updatePatches(now) {
            this.growingPatches = this.growingPatches.filter(({ mesh, born, size }) => {
                const t = Math.min((now - born) / PATCH_GROW_MS, 1);
                const c = 1.70158;
                const eased = 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
                mesh.scale.setScalar(Math.max(eased * size, 0.001));
                return t < 1;
            });
        }
        // Fixed placement in the 'local-floor' space: straight ahead of the starting position,
        // standing on the floor and facing the participant. Computed once per session.
        placePersonaInAR() {
            this.persona.mesh.position.set(0, 0, -AR_MODEL_DISTANCE);
            this.persona.mesh.rotation.set(0, 0, 0);
            this.persona.mesh.scale.setScalar(AR_MODEL_SCALE);
            this.xrPanel.mesh.position.set(0, AR_PANEL_HEIGHT, -AR_PANEL_DISTANCE);
            this.xrPanel.mesh.rotation.set(0, 0, 0);
        }
        resetPersonaPlacement() {
            this.persona.mesh.position.set(0, 0, 0);
            this.persona.mesh.rotation.set(0, 0, 0);
            this.persona.mesh.scale.setScalar(1);
        }
        onWindowResize() {
            this.camera.aspect = window.innerWidth / window.innerHeight;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(window.innerWidth, window.innerHeight);
            this.frameCamera();
        }
        // Keeps the face (where the patches land) visible below the panel on any screen size.
        // When the panel does not cover the head, the original view is kept exactly.
        frameCamera() {
            if (this.renderer.xr.isPresenting || !this.uiOverlay) return;
            const height = window.innerHeight;
            const panelBottom = this.uiOverlay.getBoundingClientRect().bottom;
            const wantedY = Math.min(panelBottom + 24, height * 0.6); // px from the top for the top of the head
            const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
            const headTop = new THREE.Vector3(0, 1.78, 0);
            const toHead = headTop.clone().sub(this.camera.position);
            const headAngle = Math.atan2(toHead.y, -toHead.z);
            const defaultY = (1 - Math.tan(headAngle) / Math.tan(halfFov)) * height / 2;
            if (defaultY >= wantedY) {
                this.camera.rotation.set(0, 0, 0);
                return;
            }
            const ndc = 1 - (2 * wantedY) / height;
            this.camera.rotation.set(headAngle - Math.atan(ndc * Math.tan(halfFov)), 0, 0);
        }
        animate() {
            // setAnimationLoop is required for WebXR; requestAnimationFrame is paused while presenting.
            this.renderer.setAnimationLoop(() => {
                if (this.pendingARPlacement) {
                    this.pendingARPlacement = false;
                    this.placePersonaInAR();
                }
                const now = performance.now();
                this.updatePatches(now);
                this.vr?.update();
                if (this.arSessionActive || this.vrSessionActive) {
                    this.updateXRInput();
                    if (this.arSessionActive)
                        this.xrPanel.update(now);
                    this.vrPanel.update(now);
                }
                this.renderer.render(this.scene, this.camera);
            });
        }
    }

    // ---------------------------------------------------------------------------
    // Laptop voice station page (index.html?station)
    // ---------------------------------------------------------------------------
    function runStation() {
        // Laptop "voice station": listens with the laptop's Chrome speech recognition when the
        // headset asks for it, then sends the transcript and sentiment back to the headset.
        const micButton = document.getElementById('btn-voice');
        const statusElement = document.getElementById('voice-status');
        const transcriptElement = document.getElementById('voice-transcript');
        const connectionElement = document.getElementById('station-connection');
        const showStatus = (status, detail) => {
            statusElement.dataset.state = status.toLowerCase().replace(/[^a-z]/g, '');
            statusElement.textContent = detail ? `${status} — ${detail}` : status;
        };
        const relay = new StationRelay({
            onCommand: (command) => {
                if (command.type === 'start')
                    voice.start();
                else
                    voice.stop();
            },
            onConnection: (state) => {
                connectionElement.dataset.state = state === 'connected' ? 'ready' : 'error';
                connectionElement.textContent =
                    state === 'connected'
                        ? 'Connected'
                        : state === 'connecting'
                            ? 'Connecting…'
                            : 'Offline — check the internet connection';
            },
        });
        connectionElement.title = `Room: ${relay.room}`;
        const voice = new VoiceController({
            onStatus: (status, detail) => {
                showStatus(status, detail);
                relay.send({ type: 'status', status, detail });
                if (status === 'Listening...') {
                    transcriptElement.hidden = true;
                    transcriptElement.textContent = '';
                }
                const listening = status === 'Listening...';
                micButton.classList.toggle('is-listening', listening);
                micButton.setAttribute('aria-pressed', String(listening));
            },
            onTranscript: (transcript) => {
                transcriptElement.hidden = false;
                transcriptElement.textContent = `"${transcript}"`;
                relay.send({ type: 'transcript', transcript });
            },
            onResult: (result) => relay.send({ type: 'result', result }),
        });
        if (!isSpeechRecognitionSupported()) {
            micButton.disabled = true;
            showStatus('Error', 'open this page in Google Chrome');
        }
        else {
            showStatus('Ready', 'press once to allow the microphone');
            micButton.addEventListener('click', () => voice.toggle());
        }
    }

    // ---------------------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------------------
    // Open index.html?station on the laptop to run the voice station.
    if (new URLSearchParams(window.location.search).has('station')) {
        document.title = 'Who are you? · Voice station';
        document.body.insertAdjacentHTML('beforeend', `
          <div id="ui-overlay" class="station">
            <div class="question">Voice station</div>
            <div class="station-help">Keep this tab open. The headset uses this laptop to listen.</div>
            <div class="voice-container">
              <button id="btn-voice" type="button" aria-pressed="false" aria-describedby="voice-status">
                <span aria-hidden="true">🎙</span> Press and speak
              </button>
              <div id="voice-status" class="voice-status" data-state="ready" role="status" aria-live="polite">Ready</div>
              <div id="voice-transcript" class="voice-transcript" hidden></div>
            </div>
            <div class="ar-container">
              <div id="station-connection" class="ar-status" data-state="ready" role="status" aria-live="polite">Connecting…</div>
            </div>
          </div>`);
        runStation();
    }
    else {
        const app = new App();
        window.app = app; // handy for debugging in the browser console
        window.startSpeechRecognition = () => app.startSpeechRecognition();
        window.THREE = THREE;
    }
})();
