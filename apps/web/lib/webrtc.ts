import type { IceServerConfig } from './api';

/** Requests camera + microphone access. Throws with the browser's native error (permission denied, no device, etc.) — callers decide how to surface it. */
export async function getLocalMedia(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({ video: true, audio: true });
}

export function createPeerConnection(iceServers: IceServerConfig[]): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers });
}

/** Stops every track on a stream — call on hangup so the camera/mic light actually turns off instead of lingering until garbage collection. */
export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((track) => track.stop());
}
