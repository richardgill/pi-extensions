import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateTail,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export type BoundedOutputSnapshot = {
  content: string;
  truncation: TruncationResult;
  lastLineBytes: number;
};

type BoundedOutputOptions = {
  maxLines?: number;
  maxBytes?: number;
};

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

// Adapted from https://github.com/earendil-works/pi/blob/v0.83.0/packages/coding-agent/src/core/tools/output-accumulator.ts
export class BoundedOutput {
  private readonly maxLines: number;
  private readonly maxBytes: number;
  private readonly maxRollingBytes: number;
  private readonly decoder = new TextDecoder();
  private tailText = "";
  private tailBytes = 0;
  private tailStartsAtLineBoundary = true;
  private totalDecodedBytes = 0;
  private completedLines = 0;
  private totalLines = 0;
  private currentLineBytes = 0;
  private hasOpenLine = false;
  private finished = false;

  constructor(options: BoundedOutputOptions = {}) {
    this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
  }

  append = (data: Buffer): void => {
    if (this.finished) throw new Error("Cannot append to finished output");
    this.appendDecodedText(this.decoder.decode(data, { stream: true }));
  };

  finish = (): void => {
    if (this.finished) return;
    this.finished = true;
    this.appendDecodedText(this.decoder.decode());
  };

  snapshot = (): BoundedOutputSnapshot => {
    const tail = truncateTail(this.getSnapshotText(), {
      maxLines: this.maxLines,
      maxBytes: this.maxBytes,
    });
    const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
    const truncatedBy = truncated
      ? (tail.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
      : null;

    return {
      content: tail.content,
      truncation: {
        ...tail,
        truncated,
        truncatedBy,
        totalLines: this.totalLines,
        totalBytes: this.totalDecodedBytes,
        maxLines: this.maxLines,
        maxBytes: this.maxBytes,
      },
      lastLineBytes: this.currentLineBytes,
    };
  };

  private appendDecodedText = (text: string): void => {
    if (text.length === 0) return;

    const bytes = byteLength(text);
    this.totalDecodedBytes += bytes;
    this.tailText += text;
    this.tailBytes += bytes;
    if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail();

    const newlineCount = text.match(/\n/g)?.length ?? 0;
    const lastNewline = text.lastIndexOf("\n");
    if (newlineCount === 0) {
      this.currentLineBytes += bytes;
      this.hasOpenLine = true;
    } else {
      this.completedLines += newlineCount;
      const tail = text.slice(lastNewline + 1);
      this.currentLineBytes = byteLength(tail);
      this.hasOpenLine = tail.length > 0;
    }
    this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
  };

  private trimTail = (): void => {
    const buffer = Buffer.from(this.tailText, "utf8");
    if (buffer.length <= this.maxRollingBytes) {
      this.tailBytes = buffer.length;
      return;
    }

    let start = buffer.length - this.maxRollingBytes;
    const boundaryOffset = buffer.subarray(start).findIndex((byte) => (byte & 0xc0) !== 0x80);
    if (boundaryOffset >= 0) start += boundaryOffset;
    this.tailStartsAtLineBoundary =
      start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
    this.tailText = buffer.subarray(start).toString("utf8");
    this.tailBytes = byteLength(this.tailText);
  };

  private getSnapshotText = (): string => {
    if (this.tailStartsAtLineBoundary) return this.tailText;
    const firstNewline = this.tailText.indexOf("\n");
    return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
  };
}
