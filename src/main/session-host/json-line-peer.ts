import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { SESSION_HOST_MAX_MESSAGE_BYTES } from "./protocol";

interface JsonLinePeerEvents<T> {
  message: [message: T];
  close: [];
  error: [error: Error];
}

export class JsonLinePeer<TIncoming, TOutgoing> extends EventEmitter<
  JsonLinePeerEvents<TIncoming>
> {
  private buffer = "";
  private closed = false;

  constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.handleData(chunk));
    socket.once("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("close");
      }
    });
    socket.once("error", (error) => this.emit("error", error));
  }

  send(message: TOutgoing): void {
    if (this.closed || this.socket.destroyed) {
      throw new Error("Session Host connection is closed.");
    }
    const encoded = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(encoded, "utf8") > SESSION_HOST_MAX_MESSAGE_BYTES) {
      throw new Error("Session Host message is too large.");
    }
    this.socket.write(encoded);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.end();
    this.emit("close");
  }

  destroy(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.socket.destroy();
    this.emit("close");
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer, "utf8") > SESSION_HOST_MAX_MESSAGE_BYTES) {
      this.emit("error", new Error("Session Host message is too large."));
      this.destroy();
      return;
    }

    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        this.emit("message", JSON.parse(line) as TIncoming);
      } catch {
        this.emit("error", new Error("Session Host sent invalid JSON."));
        this.destroy();
        return;
      }
    }
  }
}

