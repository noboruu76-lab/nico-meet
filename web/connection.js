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
    this.peers = new Map(); // peerId -> { pc, stream }
    this._handlers = {};

    this._audioCtx = null;
    this._audioDest = null;
    this._audioSources = new Map(); // streamId -> MediaStreamAudioSourceNode
  }

  on(event, handler) {
    (this._handlers[event] ||= []).push(handler);
  }

  _emit(event, payload) {
    for (const h of this._handlers[event] || []) h(payload);
  }

  // カメラ/マイクが無い・拒否された環境でも入室できるよう段階的に降格する。
  // 映像音声 → 音声のみ → 映像のみ → 視聴専用（空ストリーム）。
  // 得られたstreamのトラック構成はUI側で判定できる（stream.getVideoTracks().length など）。
  async _acquireLocalStream() {
    const attempts = [
      { constraints: { video: true, audio: true }, label: '映像+音声' },
      { constraints: { video: false, audio: true }, label: '音声のみ' },
      { constraints: { video: true, audio: false }, label: '映像のみ' },
    ];
    for (const { constraints, label } of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (label !== '映像+音声') console.warn(`[NICO Meet] ${label}で入室します（デバイス取得の降格）`);
        return stream;
      } catch (e) {
        console.warn(`[NICO Meet] getUserMedia(${label})失敗:`, e.name);
      }
    }
    console.warn('[NICO Meet] 送信できるデバイスがないため視聴専用で入室します');
    return new MediaStream();
  }

  async join() {
    this.localStream = await this._acquireLocalStream();
    this._emit('local-stream', this.localStream);

    const url = `${this.signalingUrl}?room=${encodeURIComponent(this.room)}&user=${encodeURIComponent(this.user)}`;
    this.ws = new WebSocket(url);

    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', (e) => reject(e), { once: true });
    });

    this.ws.addEventListener('message', (ev) => this._onMessage(JSON.parse(ev.data)));
    this.ws.addEventListener('close', () => {
      for (const peerId of [...this.peers.keys()]) this._removePeer(peerId);
    });

    this._emit('mode-changed', { mode: 'mesh' });
  }

  async _onMessage(msg) {
    switch (msg.type) {
      case 'peers':
        for (const peerId of msg.peers) await this._createPeer(peerId, true);
        break;
      case 'join':
        // 新規参加者からofferが来るのでここでは何もしない（契約①のグレア回避ルール）
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
    this.ws.send(JSON.stringify(msg));
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

    pc.ontrack = (ev) => {
      const entry = this.peers.get(peerId);
      if (!entry) return;
      const alreadyJoined = entry.stream?.id === ev.streams[0]?.id;
      entry.stream = ev.streams[0];
      this._rebuildMix();
      if (alreadyJoined) return; // 同じstreamの別トラック（音声/映像）到着は既知peerの更新のみ
      this._emit('peer-joined', { peerId, stream: entry.stream });
    };

    return pc;
  }

  async _createPeer(peerId, initiator) {
    if (this.peers.has(peerId)) return;
    const pc = this._createPC(peerId);
    this.peers.set(peerId, { pc, stream: null });

    if (initiator) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this._send({ type: 'offer', to: peerId, sdp: pc.localDescription });
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

  _removePeer(peerId) {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    entry.pc.close();
    this.peers.delete(peerId);
    this._emit('peer-left', { peerId });
    this._rebuildMix();
  }

  leave() {
    if (this.ws) this.ws.close();
    for (const peerId of [...this.peers.keys()]) this._removePeer(peerId);
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
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
