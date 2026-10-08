'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { getSocket } from '../lib/socket';
import { webrtcApi, type IceServerConfig } from '../lib/api';
import { createPeerConnection, getLocalMedia, stopStream } from '../lib/webrtc';
import { claimOnce, playSound, startRingback, startRingtone } from '../lib/sounds';

/** Сколько звонит входящий, прежде чем баннер пропадёт как пропущенный. */
const RING_TIMEOUT_MS = 45_000;
/** Сколько ждёт звонящий ответа, прежде чем звонок завершится с «Нет ответа». */
const NO_ANSWER_TIMEOUT_MS = 60_000;
/** Ключ localStorage: на входящий уже ответили/отклонили в другой вкладке. */
const HANDLED_KEY = 'call:handled';

function markHandled(roomId: string) {
  try {
    localStorage.setItem(HANDLED_KEY, `${roomId}|${Date.now()}`);
  } catch {
    /* ignore */
  }
}

interface RemoteStreamEntry {
  userId: string;
  stream: MediaStream | null;
}

interface ActiveCallState {
  chatId: string;
  roomId: string;
  localStream: MediaStream;
  remoteStreams: RemoteStreamEntry[];
  micEnabled: boolean;
  cameraEnabled: boolean;
  isScreenSharing: boolean;
  screenStream: MediaStream | null;
}

interface IncomingCall {
  chatId: string;
  roomId: string;
  fromUserId: string;
  fromUserDisplayName: string;
}

interface CallContextValue {
  activeCall: ActiveCallState | null;
  incomingCall: IncomingCall | null;
  isConnecting: boolean;
  error: string | null;
  startOrJoinCall: (chatId: string) => Promise<void>;
  joinIncomingCall: () => Promise<void>;
  declineIncomingCall: () => void;
  leaveCall: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => Promise<void>;
  dismissError: () => void;
}

const CallContext = createContext<CallContextValue | null>(null);

interface PeerEntry {
  connection: RTCPeerConnection;
  stream: MediaStream | null;
}

interface SignalPayload {
  type: 'offer' | 'answer' | 'ice-candidate';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
}

export function CallProvider({
  accessToken,
  currentUserId,
  children,
}: {
  accessToken: string | null;
  currentUserId: string | null;
  children: React.ReactNode;
}) {
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [incomingCall, setIncomingCall] = useState<IncomingCall | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mutable call session state, kept in refs — RTCPeerConnection and
  // MediaStream objects have no business being React state (they're
  // stateful browser objects, not serializable render inputs); `activeCall`
  // above is the render-friendly snapshot, rebuilt from these refs
  // whenever something changes.
  const peersRef = useRef<Map<string, PeerEntry>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const iceServersRef = useRef<IceServerConfig[]>([]);
  /** Мы начали звонок (а не присоединились к идущему) — нужны гудки, пока никто не ответил. */
  const [isCaller, setIsCaller] = useState(false);
  /** Подавить звук «звонок завершён» (уже прозвучало «занято»). */
  const silentEndRef = useRef(false);

  // Listens for incoming calls globally — this provider is mounted once at
  // the app root (see CallProviderBridge in layout.tsx), so this fires no
  // matter which page someone's looking at, not just while a chat window
  // happens to be open. The server only sends this once per genuinely new
  // call (see CallSignaling) — rejoining an already-announced call never
  // re-triggers it.
  useEffect(() => {
    if (!accessToken) return;
    const socket = getSocket(accessToken);

    const onIncoming = (payload: IncomingCall) => {
      // Don't interrupt with a banner for a call we're already in — e.g.
      // we started it ourselves from another tab.
      if (activeCall?.chatId === payload.chatId) return;
      setIncomingCall(payload);
    };

    // Звонящий положил трубку до ответа — баннер и рингтон убираем.
    const onEnded = ({ chatId }: { chatId: string }) => {
      setIncomingCall((prev) => (prev?.chatId === chatId ? null : prev));
    };

    socket.on('call:incoming', onIncoming);
    socket.on('call:ended', onEnded);
    return () => {
      socket.off('call:incoming', onIncoming);
      socket.off('call:ended', onEnded);
    };
  }, [accessToken, activeCall]);

  // ---- Звук входящего: рингтон + мигающий заголовок вкладки ---------------
  useEffect(() => {
    if (!incomingCall) return;
    const { roomId } = incomingCall;
    // Звенит одна вкладка из открытых (остальные показывают только баннер).
    const stopRing = claimOnce(`ring:${roomId}`, RING_TIMEOUT_MS) ? startRingtone({ maxMs: RING_TIMEOUT_MS }) : () => undefined;

    const originalTitle = document.title;
    let flip = false;
    const titleTimer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        document.title = originalTitle;
        return;
      }
      flip = !flip;
      document.title = flip ? `📞 ${incomingCall.fromUserDisplayName} звонит…` : originalTitle;
    }, 1000);

    // Не ответили — звонок считается пропущенным, баннер убираем.
    const timeout = setTimeout(() => setIncomingCall((prev) => (prev?.roomId === roomId ? null : prev)), RING_TIMEOUT_MS);

    // Ответили или отклонили в другой вкладке.
    const onStorage = (e: StorageEvent) => {
      if (e.key === HANDLED_KEY && e.newValue?.startsWith(`${roomId}|`)) setIncomingCall((prev) => (prev?.roomId === roomId ? null : prev));
    };
    window.addEventListener('storage', onStorage);

    return () => {
      stopRing();
      clearInterval(titleTimer);
      clearTimeout(timeout);
      document.title = originalTitle;
      window.removeEventListener('storage', onStorage);
    };
  }, [incomingCall]);

  const syncRemoteStreams = useCallback(() => {
    setActiveCall((prev) => {
      if (!prev) return prev;
      const remoteStreams = [...peersRef.current.entries()].map(([userId, peer]) => ({ userId, stream: peer.stream }));
      return { ...prev, remoteStreams };
    });
  }, []);

  const teardown = useCallback(() => {
    for (const peer of peersRef.current.values()) peer.connection.close();
    peersRef.current.clear();
    stopStream(localStreamRef.current);
    localStreamRef.current = null;
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    roomIdRef.current = null;
    if (accessToken) {
      const socket = getSocket(accessToken);
      socket.off('call:peer-joined');
      socket.off('call:peer-left');
      socket.off('call:signal');
      socket.off('call:declined');
    }
    setIsCaller(false);
    setActiveCall(null);
  }, [accessToken]);

  const leaveCall = useCallback(() => {
    if (accessToken && roomIdRef.current) {
      getSocket(accessToken).emit('call:leave', { roomId: roomIdRef.current });
    }
    teardown();
  }, [accessToken, teardown]);

  // Creates (or returns the existing) peer connection for `userId` — local
  // tracks attached immediately, ICE candidates and incoming remote tracks
  // wired to the signaling channel and `syncRemoteStreams` respectively.
  const getOrCreatePeer = useCallback(
    (userId: string): RTCPeerConnection => {
      const existing = peersRef.current.get(userId);
      if (existing) return existing.connection;

      const connection = createPeerConnection(iceServersRef.current);
      const localStream = localStreamRef.current;
      if (localStream) {
        for (const track of localStream.getAudioTracks()) connection.addTrack(track, localStream);
      }
      // If we're mid-screen-share when a new peer joins, they should get
      // the shared screen as their initial video track, not our camera —
      // otherwise they'd briefly see (or need a second renegotiation for)
      // the camera before the next replaceTrack() call caught them up.
      const screenStream = screenStreamRef.current;
      const screenTrack = screenStream?.getVideoTracks()[0];
      if (screenTrack && screenStream) {
        connection.addTrack(screenTrack, screenStream);
      } else {
        const cameraTrack = localStream?.getVideoTracks()[0];
        if (cameraTrack && localStream) connection.addTrack(cameraTrack, localStream);
      }

      connection.onicecandidate = (e) => {
        if (e.candidate && roomIdRef.current && accessToken) {
          const payload: SignalPayload = { type: 'ice-candidate', candidate: e.candidate.toJSON() };
          getSocket(accessToken).emit('call:signal', { roomId: roomIdRef.current, toUserId: userId, data: payload });
        }
      };

      connection.ontrack = (e) => {
        const peer = peersRef.current.get(userId);
        if (peer) {
          peer.stream = e.streams[0] ?? null;
          syncRemoteStreams();
        }
      };

      connection.onconnectionstatechange = () => {
        if (connection.connectionState === 'failed' || connection.connectionState === 'closed') {
          const peer = peersRef.current.get(userId);
          if (peer) {
            peer.stream = null;
            syncRemoteStreams();
          }
        }
      };

      peersRef.current.set(userId, { connection, stream: null });
      return connection;
    },
    [accessToken, syncRemoteStreams],
  );

  const startOrJoinCall = useCallback(
    async (chatId: string) => {
      if (!accessToken || !currentUserId) {
        setError('Нет активной сессии');
        return;
      }
      if (activeCall) return; // already in a call — leaveCall() first

      setIsConnecting(true);
      setError(null);

      let localStream: MediaStream;
      try {
        localStream = await getLocalMedia();
      } catch {
        setError('Нет доступа к камере/микрофону — проверьте разрешения браузера');
        setIsConnecting(false);
        return;
      }
      localStreamRef.current = localStream;

      try {
        const { iceServers } = await webrtcApi.getIceServers();
        iceServersRef.current = iceServers;

        const socket = getSocket(accessToken);

        const room = await new Promise<{ id: string; chatId: string; participantIds?: string[] } | null>((resolve) => {
          socket.emit('call:start', { chatId }, (r: { id: string; chatId: string; participantIds?: string[] } | null, reason?: string) => {
            if (!r) setError(reason ?? 'Не удалось начать звонок');
            resolve(r);
          });
        });
        if (!room) throw new Error('start-failed');
        roomIdRef.current = room.id;
        // В комнате никого — значит, звонок начали мы: будут гудки до ответа.
        setIsCaller((room.participantIds ?? []).length === 0);
        silentEndRef.current = false;

        const joined = await new Promise<boolean>((resolve) => {
          socket.emit('call:join', { roomId: room.id }, (ok: boolean, reason?: string) => {
            if (!ok) setError(reason ?? 'Не удалось присоединиться к звонку');
            resolve(ok);
          });
        });
        if (!joined) throw new Error('join-failed');

        setActiveCall({
          chatId,
          roomId: room.id,
          localStream,
          remoteStreams: [],
          micEnabled: true,
          cameraEnabled: true,
          isScreenSharing: false,
          screenStream: null,
        });
        setIncomingCall((prev) => (prev?.chatId === chatId ? null : prev));

        // We're already in the room — for every peer that joins *after*
        // us, we're the "existing" side of the pair and initiate the
        // offer. Whoever's already-existing when *we* join sends *us* an
        // offer instead (handled by the call:signal listener below), so
        // exactly one side ever offers per pair — no glare.
        socket.on('call:peer-joined', async ({ userId }: { userId: string }) => {
          const connection = getOrCreatePeer(userId);
          const offer = await connection.createOffer();
          await connection.setLocalDescription(offer);
          const payload: SignalPayload = { type: 'offer', sdp: offer.sdp };
          socket.emit('call:signal', { roomId: room.id, toUserId: userId, data: payload });
        });

        socket.on('call:peer-left', ({ userId }: { userId: string }) => {
          const peer = peersRef.current.get(userId);
          if (peer) {
            peer.connection.close();
            peersRef.current.delete(userId);
            syncRemoteStreams();
          }
          if (peersRef.current.size === 0) {
            // Nobody else left in the call. For a 1-on-1 call this fires
            // the instant the other person leaves; for a group call it
            // only fires once everyone else has already left one by one
            // and we're the last one remaining — either way, there's
            // nothing left to talk to, so hang up automatically instead
            // of leaving the local camera/mic running against an empty
            // call screen indefinitely.
            leaveCall();
          }
        });

        // Все, кому звонили, отклонили — «занято» и завершаем.
        socket.on('call:declined', ({ displayName, allDeclined }: { userId: string; displayName: string; allDeclined: boolean }) => {
          if (!allDeclined || peersRef.current.size > 0) return;
          silentEndRef.current = true;
          playSound('busy');
          setError(displayName ? `${displayName} отклонил(а) звонок` : 'Звонок отклонён');
          leaveCall();
        });

        socket.on('call:signal', async ({ fromUserId, data }: { fromUserId: string; data: SignalPayload }) => {
          const connection = getOrCreatePeer(fromUserId);

          if (data.type === 'offer' && data.sdp) {
            await connection.setRemoteDescription({ type: 'offer', sdp: data.sdp });
            const answer = await connection.createAnswer();
            await connection.setLocalDescription(answer);
            const payload: SignalPayload = { type: 'answer', sdp: answer.sdp };
            socket.emit('call:signal', { roomId: room.id, toUserId: fromUserId, data: payload });
          } else if (data.type === 'answer' && data.sdp) {
            await connection.setRemoteDescription({ type: 'answer', sdp: data.sdp });
          } else if (data.type === 'ice-candidate' && data.candidate) {
            try {
              await connection.addIceCandidate(data.candidate);
            } catch {
              // A candidate can legitimately arrive before setRemoteDescription
              // finishes (network jitter) — dropping it is safe, ICE keeps
              // trying with whatever candidates did land.
            }
          }
        });
      } catch {
        stopStream(localStream);
        localStreamRef.current = null;
        roomIdRef.current = null;
        setActiveCall(null);
      } finally {
        setIsConnecting(false);
      }
    },
    [accessToken, currentUserId, activeCall, getOrCreatePeer, syncRemoteStreams, leaveCall],
  );

  const toggleMic = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setActiveCall((prev) => {
      if (!prev) return prev;
      const next = !prev.micEnabled;
      stream.getAudioTracks().forEach((t) => (t.enabled = next));
      return { ...prev, micEnabled: next };
    });
  }, []);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    setActiveCall((prev) => {
      if (!prev) return prev;
      const next = !prev.cameraEnabled;
      stream.getVideoTracks().forEach((t) => (t.enabled = next));
      return { ...prev, cameraEnabled: next };
    });
  }, []);

  // Replaces the outgoing video track on every existing peer connection
  // (RTCRtpSender.replaceTrack) instead of renegotiating — the video
  // m-line in the SDP doesn't change, only which track feeds it, so this
  // is instant and doesn't interrupt audio or trigger a fresh
  // offer/answer round-trip for anyone already connected.
  const stopScreenShare = useCallback(() => {
    const cameraStream = localStreamRef.current;
    const cameraTrack = cameraStream?.getVideoTracks()[0];
    if (cameraTrack && cameraStream) {
      for (const peer of peersRef.current.values()) {
        const sender = peer.connection.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) void sender.replaceTrack(cameraTrack);
      }
    }
    stopStream(screenStreamRef.current);
    screenStreamRef.current = null;
    setActiveCall((prev) => (prev ? { ...prev, isScreenSharing: false, screenStream: null } : prev));
  }, []);

  const startScreenShare = useCallback(async () => {
    let screenStream: MediaStream;
    try {
      // Not requesting audio here — system-audio capture support varies
      // a lot across browsers/OSes and silently fails on several of them;
      // the call's own microphone audio keeps flowing unaffected either way.
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (err) {
      // AbortError/NotAllowedError-with-no-prior-prompt is the person just
      // closing the picker — expected, no need to interrupt them with an
      // error for declining their own action. Anything else (browser
      // doesn't support screen share at all, OS-level screen-recording
      // permission not granted) is worth telling them about, since
      // otherwise clicking the button just silently does nothing.
      if (err instanceof DOMException && err.name === 'NotAllowedError') return;
      setError('Не удалось начать демонстрацию экрана');
      return;
    }

    const screenTrack = screenStream.getVideoTracks()[0];
    if (!screenTrack) return;

    screenStreamRef.current = screenStream;
    for (const peer of peersRef.current.values()) {
      const sender = peer.connection.getSenders().find((s) => s.track?.kind === 'video');
      if (sender) void sender.replaceTrack(screenTrack);
    }

    // The browser's own "Stop sharing" bar ends the track directly —
    // without this, our state would think sharing is still on even
    // though the video feed already stopped.
    screenTrack.onended = () => stopScreenShare();

    setActiveCall((prev) => (prev ? { ...prev, isScreenSharing: true, screenStream } : prev));
  }, [stopScreenShare]);

  const toggleScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      stopScreenShare();
    } else {
      await startScreenShare();
    }
  }, [stopScreenShare, startScreenShare]);

  const dismissError = useCallback(() => setError(null), []);

  const joinIncomingCall = useCallback(async () => {
    if (!incomingCall) return;
    const chatId = incomingCall.chatId;
    markHandled(incomingCall.roomId);
    setIncomingCall(null);
    await startOrJoinCall(chatId);
  }, [incomingCall, startOrJoinCall]);

  const declineIncomingCall = useCallback(() => {
    if (incomingCall) {
      markHandled(incomingCall.roomId);
      if (accessToken) getSocket(accessToken).emit('call:decline', { roomId: incomingCall.roomId });
    }
    setIncomingCall(null);
  }, [accessToken, incomingCall]);

  // ---- Звуки активного звонка ---------------------------------------------
  const remoteCount = activeCall?.remoteStreams.length ?? 0;
  const inCall = !!activeCall;
  const prevRef = useRef({ inCall: false, remoteCount: 0, connected: false });

  useEffect(() => {
    const prev = prevRef.current;
    if (inCall && remoteCount > prev.remoteCount) {
      playSound(prev.remoteCount === 0 && !prev.connected ? 'call-connected' : 'peer-joined');
    } else if (inCall && remoteCount < prev.remoteCount && remoteCount > 0) {
      playSound('peer-left');
    } else if (!inCall && prev.inCall) {
      if (!silentEndRef.current) playSound('call-ended');
      silentEndRef.current = false;
    }
    prevRef.current = { inCall, remoteCount, connected: inCall && (prev.connected || remoteCount > 0) };
  }, [inCall, remoteCount]);

  // Гудки, пока никто не ответил; через минуту — «Нет ответа».
  const waiting = inCall && isCaller && remoteCount === 0;
  useEffect(() => {
    if (!waiting) return;
    const stop = startRingback({ maxMs: NO_ANSWER_TIMEOUT_MS });
    const timeout = setTimeout(() => {
      silentEndRef.current = true;
      playSound('busy');
      setError('Нет ответа');
      leaveCall();
    }, NO_ANSWER_TIMEOUT_MS);
    return () => {
      stop();
      clearTimeout(timeout);
    };
  }, [waiting, leaveCall]);

  return (
    <CallContext.Provider
      value={{
        activeCall,
        incomingCall,
        isConnecting,
        error,
        startOrJoinCall,
        joinIncomingCall,
        declineIncomingCall,
        leaveCall,
        toggleMic,
        toggleCamera,
        toggleScreenShare,
        dismissError,
      }}
    >
      {children}
    </CallContext.Provider>
  );
}

export function useCall() {
  const ctx = useContext(CallContext);
  if (!ctx) throw new Error('useCall must be used within CallProvider');
  return ctx;
}
