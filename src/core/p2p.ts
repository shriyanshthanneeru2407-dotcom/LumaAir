import { Peer, DataConnection } from 'peerjs';
import { crc32 } from './protocol';
import { ReconstructedFile } from './receiver';

export interface P2PTransferProgress {
  bytesTransferred: number;
  totalBytes: number;
  percentage: number;
  speedMBps: number;
  fileName: string;
  transferId: string;
  status: 'WAITING_FOR_SCAN' | 'CONNECTING' | 'TRANSFERRING' | 'COMPLETE' | 'ERROR';
  errorMessage?: string;
}

export interface P2PSenderCallbacks {
  onStatusChange?: (status: P2PTransferProgress['status'], detail?: string) => void;
  onProgress?: (progress: P2PTransferProgress) => void;
  onError?: (err: Error) => void;
  onComplete?: () => void;
}

export interface P2PReceiverCallbacks {
  onStatusChange?: (status: P2PTransferProgress['status'], detail?: string) => void;
  onProgress?: (progress: P2PTransferProgress) => void;
  onFileComplete?: (file: ReconstructedFile) => void;
  onError?: (err: Error) => void;
}

const CHUNK_SIZE = 64 * 1024; // 64 KB chunks for high-speed WebRTC DataChannel

export class P2PSender {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private file: File | null = null;
  private sessionId: string = '';
  private isDestroyed = false;
  private callbacks: P2PSenderCallbacks = {};

  constructor(callbacks?: P2PSenderCallbacks) {
    if (callbacks) this.callbacks = callbacks;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public getPairingUrl(): string {
    const origin = typeof window !== 'undefined' ? window.location.origin : 'https://luma-air.vercel.app';
    const path = typeof window !== 'undefined' ? window.location.pathname : '/';
    return `${origin}${path}#p2p=${this.sessionId}`;
  }

  public async prepareFile(file: File): Promise<string> {
    this.destroy();
    this.isDestroyed = false;
    this.file = file;
    // Generate clean 6-character session ID
    const rand = Math.random().toString(36).substring(2, 8);
    this.sessionId = `luma-${rand}`;

    this.notifyStatus('WAITING_FOR_SCAN');

    return new Promise((resolve, reject) => {
      this.peer = new Peer(this.sessionId, {
        debug: 1
      });

      this.peer.on('open', () => {
        resolve(this.getPairingUrl());
      });

      this.peer.on('connection', (conn) => {
        this.handleIncomingConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('[P2PSender] Peer error:', err);
        this.notifyStatus('ERROR', err.message);
        if (this.callbacks.onError) this.callbacks.onError(err);
        reject(err);
      });
    });
  }

  private handleIncomingConnection(conn: DataConnection) {
    this.connection = conn;
    this.notifyStatus('CONNECTING');

    conn.on('open', async () => {
      this.notifyStatus('TRANSFERRING');
      try {
        await this.streamFile();
      } catch (err: any) {
        console.error('[P2PSender] Stream error:', err);
        this.notifyStatus('ERROR', err.message);
        if (this.callbacks.onError) this.callbacks.onError(err);
      }
    });

    conn.on('error', (err) => {
      console.error('[P2PSender] Connection error:', err);
      this.notifyStatus('ERROR', err.message);
    });

    conn.on('close', () => {
      console.log('[P2PSender] Connection closed');
    });
  }

  private async streamFile(): Promise<void> {
    if (!this.file || !this.connection) return;

    const arrayBuffer = await this.file.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const fileChecksum = crc32(uint8);
    const totalBytes = uint8.byteLength;
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE);

    // 1. Send metadata header
    this.connection.send({
      type: 'METADATA',
      name: this.file.name,
      size: totalBytes,
      mime: this.file.type || 'application/octet-stream',
      checksum: fileChecksum,
      totalChunks
    });

    let sentBytes = 0;
    const startTime = performance.now();
    let lastProgressUpdate = performance.now();

    for (let i = 0; i < totalChunks; i++) {
      if (this.isDestroyed || !this.connection) return;

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, totalBytes);
      const chunk = uint8.subarray(start, end);

      this.connection.send({
        type: 'CHUNK',
        seq: i,
        data: chunk.buffer
      });

      sentBytes += chunk.byteLength;

      // Flow control
      const dataConn = (this.connection as any).dataChannel as RTCDataChannel | undefined;
      if (dataConn && dataConn.bufferedAmount > 512 * 1024) {
        await new Promise((r) => setTimeout(r, 20));
      }

      const now = performance.now();
      if (now - lastProgressUpdate > 100 || i === totalChunks - 1) {
        lastProgressUpdate = now;
        const elapsedSec = (now - startTime) / 1000;
        const speedMBps = elapsedSec > 0 ? (sentBytes / (1024 * 1024)) / elapsedSec : 0;
        const pct = Math.round((sentBytes / totalBytes) * 100);

        if (this.callbacks.onProgress) {
          this.callbacks.onProgress({
            bytesTransferred: sentBytes,
            totalBytes,
            percentage: pct,
            speedMBps: parseFloat(speedMBps.toFixed(1)),
            fileName: this.file.name,
            transferId: this.sessionId,
            status: 'TRANSFERRING'
          });
        }
      }
    }

    // 2. Send finish packet
    this.connection.send({
      type: 'COMPLETE',
      checksum: fileChecksum
    });

    this.notifyStatus('COMPLETE');
    if (this.callbacks.onComplete) {
      this.callbacks.onComplete();
    }
  }

  public destroy() {
    this.isDestroyed = true;
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }

  private notifyStatus(status: P2PTransferProgress['status'], detail?: string) {
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange(status, detail);
    }
  }
}

export class P2PReceiver {
  private peer: Peer | null = null;
  private connection: DataConnection | null = null;
  private callbacks: P2PReceiverCallbacks = {};
  private receivedChunks: ArrayBuffer[] = [];
  private receivedBytes = 0;
  private meta: { name: string; size: number; mime: string; checksum: number; totalChunks: number } | null = null;
  private startTime = 0;
  private reconstructedFile: ReconstructedFile | null = null;

  constructor(callbacks?: P2PReceiverCallbacks) {
    if (callbacks) this.callbacks = callbacks;
  }

  public connectToSender(targetSessionId: string): Promise<void> {
    this.destroy();
    this.notifyStatus('CONNECTING');
    this.receivedChunks = [];
    this.receivedBytes = 0;
    this.meta = null;
    this.reconstructedFile = null;

    return new Promise((resolve, reject) => {
      this.peer = new Peer({ debug: 1 });

      this.peer.on('open', () => {
        if (!this.peer) return;
        const conn = this.peer.connect(targetSessionId, { reliable: true });
        this.connection = conn;

        conn.on('open', () => {
          this.startTime = performance.now();
          this.notifyStatus('TRANSFERRING');
          resolve();
        });

        conn.on('data', (data: any) => {
          this.handleIncomingData(data);
        });

        conn.on('error', (err) => {
          console.error('[P2PReceiver] Connection error:', err);
          this.notifyStatus('ERROR', err.message);
          if (this.callbacks.onError) this.callbacks.onError(err);
          reject(err);
        });

        conn.on('close', () => {
          console.log('[P2PReceiver] Connection closed');
        });
      });

      this.peer.on('error', (err) => {
        console.error('[P2PReceiver] Peer error:', err);
        this.notifyStatus('ERROR', err.message);
        if (this.callbacks.onError) this.callbacks.onError(err);
        reject(err);
      });
    });
  }

  private handleIncomingData(data: any) {
    if (!data) return;

    if (data.type === 'METADATA') {
      this.meta = {
        name: data.name,
        size: data.size,
        mime: data.mime,
        checksum: data.checksum,
        totalChunks: data.totalChunks
      };
      this.receivedChunks = new Array(this.meta.totalChunks);
      this.notifyProgress();
    } else if (data.type === 'CHUNK') {
      const seq = data.seq;
      const buffer = data.data as ArrayBuffer;
      this.receivedChunks[seq] = buffer;
      this.receivedBytes += buffer.byteLength;
      this.notifyProgress();
    } else if (data.type === 'COMPLETE') {
      this.finalizeTransfer();
    }
  }

  private notifyProgress() {
    if (!this.meta || !this.callbacks.onProgress) return;
    const now = performance.now();
    const elapsedSec = (now - this.startTime) / 1000;
    const speedMBps = elapsedSec > 0 ? (this.receivedBytes / (1024 * 1024)) / elapsedSec : 0;
    const pct = this.meta.size > 0 ? Math.min(100, Math.round((this.receivedBytes / this.meta.size) * 100)) : 0;

    this.callbacks.onProgress({
      bytesTransferred: this.receivedBytes,
      totalBytes: this.meta.size,
      percentage: pct,
      speedMBps: parseFloat(speedMBps.toFixed(1)),
      fileName: this.meta.name,
      transferId: this.meta.name,
      status: 'TRANSFERRING'
    });
  }

  private finalizeTransfer() {
    if (!this.meta) return;

    const totalLength = this.receivedBytes;
    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of this.receivedChunks) {
      if (chunk) {
        combined.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
      }
    }

    const calculatedCrc = crc32(combined);
    if (calculatedCrc !== this.meta.checksum) {
      this.notifyStatus('ERROR', 'CRC32 integrity verification failed');
      return;
    }

    const blob = new Blob([combined], { type: this.meta.mime });
    const downloadUrl = URL.createObjectURL(blob);
    const fileExt = this.meta.name.split('.').pop() || '';
    const isImage = this.meta.mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(fileExt);

    let textPreview: string | undefined = undefined;
    if (this.meta.mime.startsWith('text/') || ['txt', 'md', 'json', 'csv'].includes(fileExt) || combined.byteLength < 5000) {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(combined);
        textPreview = text.length > 500 ? text.substring(0, 500) + '...' : text;
      } catch {}
    }

    this.reconstructedFile = {
      fileName: this.meta.name,
      fileExt,
      fileSize: totalLength,
      mimeType: this.meta.mime,
      transferId: this.meta.name,
      checksum: calculatedCrc,
      blob,
      downloadUrl,
      textPreview,
      isImage
    };

    this.notifyStatus('COMPLETE');
    if (this.callbacks.onFileComplete) {
      this.callbacks.onFileComplete(this.reconstructedFile);
    }
  }

  public downloadFile() {
    if (!this.reconstructedFile) return;
    const a = document.createElement('a');
    a.href = this.reconstructedFile.downloadUrl;
    a.download = this.reconstructedFile.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  public destroy() {
    if (this.connection) {
      this.connection.close();
      this.connection = null;
    }
    if (this.peer) {
      this.peer.destroy();
      this.peer = null;
    }
  }

  private notifyStatus(status: P2PTransferProgress['status'], detail?: string) {
    if (this.callbacks.onStatusChange) {
      this.callbacks.onStatusChange(status, detail);
    }
  }
}
