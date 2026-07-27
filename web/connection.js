// NICO Meet — 契約②の実装（担当A所管・クラス名/メソッド名/イベント名は変更禁止）
// UI/録画側はWebRTC内部を知らず、このAPIだけを使う。

export class ConnectionManager {
  constructor({ room, user, signalingUrl, iceServers }) {
    this.room = room;
    this.user = user;
    this.signalingUrl = signalingUrl;
    this.iceServers = iceServers || [{ urls: 'stun:stun.l.google.com:19302' }];

    this.ws = null;
    this.localStream = null;
    this.peers = new Map(); // peerId -> { pc, stream, initiator, recoverTimer, iceRetry }
    this._handlers = {};

    // モバイルは上り帯域が細いので送信解像度・ビットレートを絞る（#パッチ④）
    this._isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(
      (typeof navigator !== 'undefined' && navigator.userAgent) || ''
    );

    // 実デバイスの有無（UIの「音声なし/映像なし」表示用。無音プレースホルダとは区別する）
    this.hasLocalVideo = false;
    this.hasLocalAudio = false;

    // 音声mix（録画用）
    this._audioCtx = null;
    this._audioDest = null;
    this._audioSources = new Map(); // streamId -> MediaStreamAudioSourceNode
    this._sinkAudioEls = new Map(); // peerId -> HTMLAudioElement（Chrome録音対策 #7）
    this._silentCtx = null;         // 視聴専用の無音トラック用（GC防止に保持 #2）

    // WS自動再接続（#4）
    this._leaving = false;
    this._everConnected = false;
    this._joinedOnce = false;
    this._reconnectAttempts = 0;
    this._reconnectTimer = null;
    this._iceQueue = [];            // { msg, expires }
    this._onlineHandler = null;
    this._visibilityHandler = null;
  }

  on(event, handler) {
    (this._handlers[event] ||= []).push(handler);
  }

  _emit(event, payload) {
    for (const h of this._handlers[event] || []) h(payload);
  }

  // カメラ/マイクが無い・拒否された環境でも入室できるよう段階的に降格する。
  // 映像音声 → 音声のみ → 映像のみ → 視聴専用（無音トラック1本）。
  async _acquireLocalStream() {
    // モバイルは640x360/20fpsに抑える。PC等は制約なし（ブラウザ既定）。
    const video = this._isMobile
      ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 20 } }
      : true;
    const attempts = [
      { constraints: { video, audio: true }, label: '映像+音声' },
      { constraints: { video: false, audio: true }, label: '音声のみ' },
      { constraints: { video, audio: false }, label: '映像のみ' },
    ];
    for (const { constraints, label } of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        this.hasLocalVideo = stream.getVideoTracks().length > 0;
        this.hasLocalAudio = stream.getAudioTracks().length > 0;
        if (label !== '映像+音声') console.warn(`[NICO Meet] ${label}で入室します（デバイス取得の降格）`);
        return stream;
      } catch (e) {
        console.warn(`[NICO Meet] getUserMedia(${label})失敗:`, e.name);
      }
    }
    // 送れるデバイスが無くても、無音トラックを1本送ることで“他の参加者から見える”ようにする（#2）。
    // 空ストリーム（0本）だと相手側で ontrack が起きず、参加者一覧に出てこないため。
    console.warn('[NICO Meet] 送信デバイスなし。無音トラックで視聴専用参加します');
    this.hasLocalVideo = false;
    this.hasLocalAudio = false;
    return new MediaStream([this._createSilentAudioTrack()]);
  }

  _createSilentAudioTrack() {
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dst = ctx.createMediaStreamDestination();
    osc.connect(dst);
    osc.start();
    const track = dst.stream.getAudioTracks()[0];
    track.enabled = false; // 無音（送信はするが音は出さない）
    this._silentCtx = ctx;
    return track;
  }

  async join() {
    this.localStream = await this._acquireLocalStream();
    this._emit('local-stream', this.localStream);
    await this._connectWs();
    this._installResumeHooks();
    this._emit('mode-changed', { mode: 'mesh' });
  }

  // WS接続。初回・再接続の両方でこれを使う。
  _connectWs() {
    const url = `${this.signalingUrl}?room=${encodeURIComponent(this.room)}&user=${encodeURIComponent(this.user)}`;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.addEventListener('open', () => {
        this._everConnected = true;
        this._reconnectAttempts = 0;
        this._flushIceQueue();
        settled = true;
        resolve();
      }, { once: true });

      ws.addEventListener('message', (ev) => this._onMessage(JSON.parse(ev.data)));

      ws.addEventListener('close', () => {
        // 意図的なleaveや初回接続失敗では再接続しない。
        // それ以外は既存P2Pを畳まず再接続する（WSは合図専用。確立済みメディアはWSに依存しない）。
        if (this._leaving || !this._everConnected) return;
        this._scheduleReconnect();
      });

      ws.addEventListener('error', (e) => {
        if (!settled) { settled = true; reject(e); }
        // 接続済みなら close 側で再接続がかかる
      });
    });
  }

  _scheduleReconnect() {
    if (this._leaving || this._reconnectTimer) return;
    if (this._reconnectAttempts >= 12) {
      console.error('[NICO Meet] 再接続を上限(12回)まで試みました。諦めます');
      return;
    }
    const attempt = ++this._reconnectAttempts;
    const base = Math.min(30000, 500 * 2 ** attempt);
    const delay = base / 2 + Math.random() * (base / 2); // 指数バックオフ＋ジッター
    console.warn(`[NICO Meet] WS切断。${Math.round(delay)}ms後に再接続（${attempt}/12）`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      try {
        await this._connectWs();
      } catch (e) {
        this._scheduleReconnect();
      }
    }, delay);
  }

  // iOSは凍結中に setTimeout が止まるため、画面復帰・オンライン復帰で即再接続する（#4-5）。
  resumeIfDropped() {
    if (this._leaving || !this._everConnected) return;
    const st = this.ws?.readyState;
    const dead = !this.ws || st === WebSocket.CLOSED || st === WebSocket.CLOSING;
    if (dead && !this._reconnectTimer) {
      this._reconnectAttempts = 0;
      this._scheduleReconnect();
    }
  }

  _installResumeHooks() {
    this._onlineHandler = () => this.resumeIfDropped();
    this._visibilityHandler = () => { if (document.visibilityState === 'visible') this.resumeIfDropped(); };
    window.addEventListener('online', this._onlineHandler);
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  _removeResumeHooks() {
    if (this._onlineHandler) window.removeEventListener('online', this._onlineHandler);
    if (this._visibilityHandler) document.removeEventListener('visibilitychange', this._visibilityHandler);
    this._onlineHandler = this._visibilityHandler = null;
  }

  async _onMessage(msg) {
    switch (msg.type) {
      case 'peers': {
        const current = new Set(msg.peers);
        // 再接続時：断中に抜けた相手だけ落とす（幽霊タイル対策）。初回は何も落とさない。
        // ただしP2Pがまだ生きている相手は残す。サーバー再起動で部屋の記憶が消えると
        // peersリストが空になるが、それは「相手が抜けた」ではなく「サーバーが忘れた」だけ。
        // 真実の情報源はP2Pの生死（failed/closedなら本当に切れている）。
        if (this._joinedOnce) {
          for (const [id, entry] of this.peers) {
            const st = entry.pc.connectionState;
            if (!current.has(id) && (st === 'failed' || st === 'closed')) {
              this._removePeer(id);
            }
          }
        }
        this._joinedOnce = true;
        // 未接続の相手にだけ offer（_createPeer が既存はスキップ）
        for (const peerId of msg.peers) await this._createPeer(peerId, true);
        break;
      }
      case 'join':
        // 新規参加者から offer が来るのでここでは待つ（契約①のグレア回避ルール）
        break;
      case 'offer':
        await this._handleOffer(msg);
        break;
      case 'answer':
        await this._handleAnswer(msg);
        break;
      case 'ice':
        await this._handleIce(msg);
        break;
      case 'leave':
        this._removePeer(msg.user);
        break;
    }
  }

  _send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return;
    }
    // WS断中：ice だけ貯める（TTL10秒・上限200）。
    // offer/answer は遅延到着で相手の状態機械と食い違うため貯めない。
    if (msg.type === 'ice' && this._iceQueue.length < 200) {
      this._iceQueue.push({ msg, expires: Date.now() + 10000 });
    }
  }

  _flushIceQueue() {
    const now = Date.now();
    const q = this._iceQueue;
    this._iceQueue = [];
    for (const { msg, expires } of q) {
      if (expires > now && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
      }
    }
  }

  _createPC(peerId) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });

    for (const track of this.localStream.getTracks()) {
      pc.addTrack(track, this.localStream);
    }

    // 送るトラックが無い種別は「受信専用」の枠を明示的に作る。
    // これが無いとSDPにその種別のm-lineが立たず、相手の映像/音声を受け取れない。
    if (this.localStream.getAudioTracks().length === 0) {
      pc.addTransceiver('audio', { direction: 'recvonly' });
    }
    if (this.localStream.getVideoTracks().length === 0) {
      pc.addTransceiver('video', { direction: 'recvonly' });
    }

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        this._send({ type: 'ice', to: peerId, candidate: ev.candidate });
      }
    };

    // モバイルは送信ビットレートを絞る（#パッチ④）。addTrack後にsenderへ反映。
    if (this._isMobile) this._applyMobileBitrate(pc);

    // ICE復旧（#パッチ③）。基地局切替・一過性断・失敗に対応。
    // 契約②を変えないため peer-failed は発火せず、復旧不能時は既存の peer-left で畳む。
    pc.onconnectionstatechange = () => {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      const st = pc.connectionState;
      if (st === 'disconnected') {
        // 一過性の断。5秒待って戻らなければ張り直す（即restartは無駄打ち）
        clearTimeout(entry.recoverTimer);
        entry.recoverTimer = setTimeout(() => {
          if (this.peers.get(peerId)?.pc.connectionState === 'disconnected') {
            this._restartIce(peerId);
          }
        }, 5000);
      } else if (st === 'connected') {
        clearTimeout(entry.recoverTimer);
        entry.recoverTimer = null;
        entry.iceRetry = 0;
      } else if (st === 'failed') {
        clearTimeout(entry.recoverTimer);
        entry.recoverTimer = null;
        // 無限ループ防止。TURNが無い環境では何度やっても成功しないため回数制限。
        if ((entry.iceRetry ?? 0) < 3) {
          entry.iceRetry = (entry.iceRetry ?? 0) + 1;
          this._restartIce(peerId);
        } else {
          console.error(`[NICO Meet] peer ${peerId} はICE復旧に失敗。切断扱いにします（TURN未導入だと対称NATは救えません）`);
          this._removePeer(peerId); // 既存イベント peer-left でUIに反映
        }
      }
    };

    pc.ontrack = (ev) => {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      const alreadyJoined = entry.stream?.id === ev.streams[0]?.id;
      entry.stream = ev.streams[0];
      this._attachSinkAudio(peerId, entry.stream); // Chrome録音対策（#7）
      this._rebuildMix();
      if (alreadyJoined) return; // 同じstreamの別トラック（音声/映像）到着は既知peerの更新のみ
      this._emit('peer-joined', { peerId, stream: entry.stream });
    };

    return pc;
  }

  async _createPeer(peerId, initiator) {
    if (this.peers.has(peerId)) return;
    const pc = this._createPC(peerId);
    this.peers.set(peerId, { pc, stream: null, initiator, recoverTimer: null, iceRetry: 0 });

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', to: peerId, sdp: pc.localDescription });
    }
  }

  // ICE restart（offer側のみ実施しグレアを避ける）。createOffer({iceRestart})で
  // 新しいufrag/pwdの再ネゴを起こす。相手は通常の_handleOfferで応答する。
  async _restartIce(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry || !entry.initiator) return;
    try {
      const offer = await entry.pc.createOffer({ iceRestart: true });
      await entry.pc.setLocalDescription(offer);
      this._send({ type: 'offer', to: peerId, sdp: entry.pc.localDescription });
    } catch (e) {
      console.error('[NICO Meet] ICE restart失敗', e);
    }
  }

  // モバイルの送信ビットレート・劣化方針。addTrack済みのvideo senderに反映。
  _applyMobileBitrate(pc) {
    for (const sender of pc.getSenders()) {
      if (sender.track?.kind !== 'video') continue;
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
      params.encodings[0].maxBitrate = 500_000; // 500kbps
      params.degradationPreference = 'maintain-framerate'; // 帯域低下時はまず解像度を落とす
      sender.setParameters(params).catch((e) => console.warn('[NICO Meet] setParameters失敗', e));
    }
  }

  async _handleOffer(msg) {
    await this._createPeer(msg.from, false);
    const { pc } = this.peers.get(msg.from);
    await pc.setRemoteDescription(msg.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._send({ type: 'answer', to: msg.from, sdp: pc.localDescription });
  }

  async _handleAnswer(msg) {
    const entry = this.peers.get(msg.from);
    if (!entry) return;
    await entry.pc.setRemoteDescription(msg.sdp);
  }

  async _handleIce(msg) {
    const entry = this.peers.get(msg.from);
    if (!entry) return;
    try {
      await entry.pc.addIceCandidate(msg.candidate);
    } catch (e) {
      console.error('addIceCandidate failed', e);
    }
  }

  // 相手の音声を <audio muted> にも流す。Chromeは相手trackを
  // MediaStreamAudioSourceNode に繋いでも、メディア要素に載っていないと無音になるため
  // （録音mixに相手の声が入らない既知の挙動）。実際の音はUIの<video>が出す＝muted。
  _attachSinkAudio(peerId, stream) {
    if (!stream || stream.getAudioTracks().length === 0) return;
    let el = this._sinkAudioEls.get(peerId);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      el.muted = true;
      this._sinkAudioEls.set(peerId, el);
    }
    el.srcObject = stream;
    const p = el.play?.();
    if (p) p.catch(() => {});
  }

  _detachSinkAudio(peerId) {
    const el = this._sinkAudioEls.get(peerId);
    if (el) {
      el.srcObject = null;
      this._sinkAudioEls.delete(peerId);
    }
  }

  _removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    if (entry.recoverTimer) clearTimeout(entry.recoverTimer); // タイマーのリーク解除
    entry.pc.close();
    this.peers.delete(peerId);
    this._detachSinkAudio(peerId);
    this._emit('peer-left', { peerId });
    this._rebuildMix();
  }

  leave() {
    this._leaving = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._removeResumeHooks();
    if (this.ws) this.ws.close();
    for (const peerId of [...this.peers.keys()]) this._removePeer(peerId);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }
    if (this._silentCtx) {
      this._silentCtx.close().catch(() => {});
      this._silentCtx = null;
    }
  }

  toggleMic(on) {
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = on));
  }

  toggleCam(on) {
    this.localStream?.getVideoTracks().forEach((t) => (t.enabled = on));
  }

  getMixedAudioTrack() {
    this._rebuildMix();
    if (this._audioCtx.state === 'suspended') this._audioCtx.resume();
    return this._audioDest.stream.getAudioTracks()[0];
  }

  // 出力先(destination)は最初の1回だけ作り、以後は各人の音声ソースを繋ぎ替えるだけ。
  // → getMixedAudioTrack()が一度返したトラックは、人数が増減しても生き続ける（録画が途切れない）。
  _rebuildMix() {
    if (!this._audioCtx) {
      this._audioCtx = new AudioContext();
      this._audioDest = this._audioCtx.createMediaStreamDestination();
    }

    // 現在mixに含めるべきstream一覧（自分＋相手全員）
    const wanted = new Map(); // streamId -> stream
    for (const stream of [this.localStream, ...[...this.peers.values()].map((p) => p.stream)]) {
      if (stream && stream.getAudioTracks().length > 0) wanted.set(stream.id, stream);
    }

    // 消えたstreamのソースを切断・破棄
    for (const [id, src] of this._audioSources) {
      if (!wanted.has(id)) {
        src.disconnect();
        this._audioSources.delete(id);
      }
    }

    // 新しく増えたstreamのソースを接続
    for (const [id, stream] of wanted) {
      if (!this._audioSources.has(id)) {
        const src = this._audioCtx.createMediaStreamSource(stream);
        src.connect(this._audioDest);
        this._audioSources.set(id, src);
      }
    }
  }
}
